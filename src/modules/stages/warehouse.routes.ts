import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import {
  containers,
  items,
  locations,
  orderLines,
  orders,
  suppliers,
  teams,
  transports,
  warehouseReceiptLines,
  warehouseReceipts,
} from "../../db/schema";
import { conflict, notFound, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import { loadLandedCosts } from "../costs/landed-cost";
import type { RouteContext } from "../context";
import { round2 } from "../orders/orders.routes";
import { moveOrdersToStage } from "../stages-shared";
import { canSeeCost, closed, complete, containerOrders, count, goodsIn, isUuid, required, STAGE_MESSAGES, todayInIndia } from "./common";

// Owner: A5. WH-1 GET /warehouse-receipts, WH-2 GET /warehouse-receipts/:transportId, WH-3 PUT
// /warehouse-receipts/:transportId (docs/wave3-contracts.md sections 2, 3 and 5; shapes in section 8).
// Cost figures come from loadLandedCosts and are null unless the user has landedCost >= View (section 3).

export const WAREHOUSE_MESSAGES = {
  location: "Choose a warehouse from the list.",
  receivedOn: "Enter the date received.",
  receivedFuture: "The received date can't be after today.",
  receivedBeforeUnloaded: "The received date can't be before the unloading date.",
  receivedBy: "Enter who received the goods.",
  bundles: "Enter the bundles received (0 or more).",
  quantity: "Quantities must be whole numbers, 0 or more.",
  unknownLine: "Choose lines from this container.",
  team: "Choose an active team.",
  duplicateLine: "Each line can appear only once per team.",
  overSplit: (item: string, po: string, quantity: number, unit: string) => `${item} (${po}): only ${quantity} ${unit} in this container.`,
  nothingAssigned: "Give at least one piece to a team.",
};
const M = WAREHOUSE_MESSAGES;

const receiptBody = z.strictObject({
  locationId: z.uuid({ error: M.location }),
  receivedOn: z.iso.date({ error: M.receivedOn }),
  receivedBy: required(M.receivedBy),
  bundlesReceived: count(M.bundles),
  lines: z
    .array(
      z.strictObject({
        orderLineId: z.uuid({ error: M.unknownLine }),
        teamId: z.uuid({ error: M.team }),
        quantity: count(M.quantity),
      }),
      { error: M.quantity },
    )
    .max(1000, M.unknownLine)
    .refine((lines) => new Set(lines.map((line) => `${line.orderLineId}:${line.teamId}`)).size === lines.length, M.duplicateLine)
    .default([]),
  complete,
});

type RowTotals = {
  id: string;
  location: { id: string; name: string };
  received: number;
  /** Pieces per team id. */
  teams: Record<string, number>;
  costPerPieceInr: number | null;
};

const mainLine = alias(orderLines, "main_line");

/** Active teams, plus `extra` (teams already on a saved receipt), in creation order. */
const teamOptions = (db: RouteContext["db"], extra: string[] = []) =>
  db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(or(eq(teams.status, "Active"), extra.length ? inArray(teams.id, extra) : undefined))
    .orderBy(asc(teams.createdAt), asc(teams.name));

export function warehouseRoutes({ db }: RouteContext) {
  const router = Router();

  // WH-1. One row per order per stocked receipt (newest first), with its pieces per team; trips unloaded and not yet
  // stocked, oldest first.
  router.get("/warehouse-receipts", requirePermission("warehouse", "View"), async (req, res) => {
    const [lines, ready, teamList, warehouses] = await Promise.all([
      db
        .select({
          receiptId: warehouseReceipts.id,
          transportId: warehouseReceipts.transportId,
          receivedOn: warehouseReceipts.receivedOn,
          receivedBy: warehouseReceipts.receivedBy,
          locationId: locations.id,
          locationName: locations.name,
          container: containers.number,
          orderId: orders.id,
          po: orders.poNumber,
          item: items.name,
          supplier: suppliers.name,
          teamId: warehouseReceiptLines.teamId,
          quantity: warehouseReceiptLines.quantity,
        })
        .from(warehouseReceiptLines)
        .innerJoin(warehouseReceipts, and(eq(warehouseReceipts.id, warehouseReceiptLines.receiptId), eq(warehouseReceipts.status, "stocked")))
        .innerJoin(locations, eq(locations.id, warehouseReceipts.locationId))
        .innerJoin(transports, eq(transports.id, warehouseReceipts.transportId))
        .innerJoin(containers, eq(containers.id, transports.containerId))
        .innerJoin(orderLines, eq(orderLines.id, warehouseReceiptLines.orderLineId))
        .innerJoin(orders, eq(orders.id, orderLines.orderId))
        .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
        .innerJoin(mainLine, and(eq(mainLine.orderId, orders.id), eq(mainLine.position, 0)))
        .innerJoin(items, eq(items.id, mainLine.itemId))
        .orderBy(desc(warehouseReceipts.receivedOn), desc(warehouseReceipts.createdAt), asc(warehouseReceipts.id), asc(orders.poNumber)),
      db
        .select({
          transportId: transports.id,
          containerId: containers.id,
          container: containers.number,
          vehicleNumber: transports.vehicleNumber,
          lrNumber: transports.lrNumber,
          unloadedOn: transports.unloadedOn,
          bundlesReceived: transports.bundlesReceived,
          destination: locations.name,
          receiptStatus: warehouseReceipts.status,
        })
        .from(transports)
        .innerJoin(containers, eq(containers.id, transports.containerId))
        .innerJoin(locations, eq(locations.id, transports.destinationId))
        .leftJoin(warehouseReceipts, eq(warehouseReceipts.transportId, transports.id))
        .where(and(eq(transports.status, "unloaded"), or(isNull(warehouseReceipts.id), eq(warehouseReceipts.status, "draft"))))
        .orderBy(asc(transports.unloadedOn), asc(transports.createdAt)),
      teamOptions(db),
      db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(
          and(
            eq(locations.type, "Warehouse"),
            or(eq(locations.status, "Active"), inArray(locations.id, db.select({ id: warehouseReceipts.locationId }).from(warehouseReceipts))),
          ),
        )
        .orderBy(asc(locations.createdAt), asc(locations.name)),
    ]);

    const [costs, byContainer] = await Promise.all([
      canSeeCost(req.user!) ? loadLandedCosts(db, [...new Set(lines.map((line) => line.orderId))]) : null,
      containerOrders(
        db,
        ready.map((trip) => trip.containerId),
      ),
    ]);
    // Lines arrive grouped by receipt and PO, so the rows keep that order.
    const rows = new Map<string, Omit<(typeof lines)[number], "teamId" | "quantity" | "locationId" | "locationName"> & RowTotals>();
    for (const { teamId, quantity, locationId, locationName, ...line } of lines) {
      const key = `${line.receiptId}:${line.orderId}`;
      const row = rows.get(key) ?? {
        ...line,
        id: key,
        location: { id: locationId, name: locationName },
        received: 0,
        teams: {},
        costPerPieceInr: costs?.get(line.orderId)?.perPieceInr ?? null,
      };
      row.received += quantity;
      row.teams[teamId] = (row.teams[teamId] ?? 0) + quantity;
      rows.set(key, row);
    }
    res.json({
      rows: [...rows.values()],
      ready: ready.map((trip) => ({ ...trip, orders: byContainer.get(trip.containerId)?.orders ?? [] })),
      teams: teamList,
      warehouses,
    });
  });

  // WH-2. Any trip (the form says when it isn't unloaded). `lines` are the container's lines, the quantities to split.
  router.get("/warehouse-receipts/:transportId", requirePermission("warehouse", "View"), async (req, res) => {
    const id = String(req.params.transportId);
    if (!isUuid(id)) throw notFound("Trip");
    const trip = (
      await db
        .select({
          id: transports.id,
          containerId: containers.id,
          container: containers.number,
          terms: containers.terms,
          vehicleNumber: transports.vehicleNumber,
          lrNumber: transports.lrNumber,
          bundlesLoaded: transports.bundlesLoaded,
          bundlesReceived: transports.bundlesReceived,
          unloadedOn: transports.unloadedOn,
          destinationId: transports.destinationId,
          status: transports.status,
        })
        .from(transports)
        .innerJoin(containers, eq(containers.id, transports.containerId))
        .where(eq(transports.id, id))
    )[0];
    if (!trip) throw notFound("Trip");
    const saved = (
      await db
        .select({
          id: warehouseReceipts.id,
          locationId: warehouseReceipts.locationId,
          receivedOn: warehouseReceipts.receivedOn,
          receivedBy: warehouseReceipts.receivedBy,
          bundlesReceived: warehouseReceipts.bundlesReceived,
          status: warehouseReceipts.status,
        })
        .from(warehouseReceipts)
        .where(eq(warehouseReceipts.transportId, id))
    )[0];
    const savedLines = saved
      ? await db
          .select({ orderLineId: warehouseReceiptLines.orderLineId, teamId: warehouseReceiptLines.teamId, quantity: warehouseReceiptLines.quantity })
          .from(warehouseReceiptLines)
          .where(eq(warehouseReceiptLines.receiptId, saved.id))
      : [];
    const goods = await goodsIn(db, trip.containerId);
    const orderIds = [...new Set(goods.map((line) => line.orderId))];
    const [teamList, warehouses, costs, ordered] = await Promise.all([
      teamOptions(db, [...new Set(savedLines.map((line) => line.teamId))]),
      db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(or(and(eq(locations.type, "Warehouse"), eq(locations.status, "Active")), saved ? eq(locations.id, saved.locationId) : undefined))
        .orderBy(asc(locations.createdAt), asc(locations.name)),
      canSeeCost(req.user!) ? loadLandedCosts(db, orderIds) : null,
      orderIds.length
        ? db
            .select({ pieces: sql<number>`coalesce(sum(${orderLines.quantity}), 0)`.mapWith(Number) })
            .from(orderLines)
            .where(inArray(orderLines.orderId, orderIds))
        : [{ pieces: 0 }],
    ]);

    // Cost so far: the landed cost of the orders in this container, added up; null parts stay null until one exists.
    const list = costs ? orderIds.map((orderId) => costs.get(orderId)!) : [];
    const add = (pick: (cost: (typeof list)[number]) => number | null) =>
      list.some((cost) => pick(cost) !== null) ? round2(list.reduce((sum, cost) => sum + (pick(cost) ?? 0), 0)) : null;
    res.json({
      trip,
      receipt: saved ? { ...saved, lines: savedLines } : null,
      lines: goods.map(({ orderLineId, orderId, po, item, unit, quantity }) => ({ orderLineId, orderId, po, item, unit, quantity })),
      teams: teamList,
      warehouses,
      cost: costs
        ? {
            goodsInr: add((cost) => cost.goodsInr)!,
            seaFreightInr: add((cost) => cost.seaFreightInr)!,
            clearingInr: add((cost) => cost.clearingInr),
            transportInr: add((cost) => cost.transportInr),
            totalInr: add((cost) => cost.totalInr)!,
            orderedPieces: ordered[0]!.pieces,
            final: list.length > 0 && list.every((cost) => cost.final),
          }
        : null,
    });
  });

  // WH-3. One transaction: the trip, then its receipt, locked. Stocking moves the orders to 6.
  router.put("/warehouse-receipts/:transportId", requirePermission("warehouse", "Enter"), async (req, res) => {
    const id = String(req.params.transportId);
    if (!isUuid(id)) throw notFound("Trip");
    const input = parse(receiptBody, req.body);
    const receipt = await db.transaction(async (tx) => {
      const trip = (await tx.select().from(transports).where(eq(transports.id, id)).for("update"))[0];
      if (!trip) throw notFound("Trip");
      if (trip.status !== "unloaded") throw conflict("not_unloaded", STAGE_MESSAGES.notUnloaded);
      const saved = (await tx.select({ id: warehouseReceipts.id, status: warehouseReceipts.status }).from(warehouseReceipts).where(eq(warehouseReceipts.transportId, id)).for("update"))[0];
      if (saved?.status === "stocked") throw closed();

      const problems: Record<string, string> = {};
      if (input.receivedOn > todayInIndia()) problems.receivedOn = M.receivedFuture;
      else if (input.receivedOn < trip.unloadedOn!) problems.receivedOn = M.receivedBeforeUnloaded;
      // One query at a time: a transaction's client runs queries in sequence.
      const location = await tx
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.id, input.locationId), eq(locations.type, "Warehouse"), eq(locations.status, "Active")));
      const activeTeams = await tx.select({ id: teams.id }).from(teams).where(eq(teams.status, "Active"));
      const goods = await goodsIn(tx, trip.containerId);
      if (location.length === 0) problems.locationId = M.location;
      const active = new Set(activeTeams.map((team) => team.id));
      const byLine = new Map(goods.map((line) => [line.orderLineId, line]));
      const split = new Map<string, number>();
      for (const { orderLineId, teamId, quantity } of input.lines) {
        if (!byLine.has(orderLineId)) problems.lines ??= M.unknownLine;
        else if (!active.has(teamId)) problems.lines ??= M.team;
        else split.set(orderLineId, (split.get(orderLineId) ?? 0) + quantity);
      }
      for (const [orderLineId, pieces] of split) {
        const line = byLine.get(orderLineId)!;
        if (pieces > line.quantity) problems.lines ??= M.overSplit(line.item, line.po, line.quantity, line.unit);
      }
      if (input.complete && !problems.lines && [...split.values()].every((pieces) => pieces === 0)) problems.lines = M.nothingAssigned;
      if (Object.keys(problems).length > 0) throw validationFailed(problems);

      const { complete: done, lines, ...values } = input;
      const row = { ...values, status: done ? "stocked" : "draft", updatedBy: req.user!.id };
      const written = saved
        ? await tx.update(warehouseReceipts).set(row).where(eq(warehouseReceipts.id, saved.id)).returning({ id: warehouseReceipts.id, status: warehouseReceipts.status })
        : await tx
            .insert(warehouseReceipts)
            .values({ ...row, transportId: id, createdBy: req.user!.id })
            .returning({ id: warehouseReceipts.id, status: warehouseReceipts.status });
      const receiptId = written[0]!.id;
      // The split is replaced as a whole; zero quantities aren't stored.
      await tx.delete(warehouseReceiptLines).where(eq(warehouseReceiptLines.receiptId, receiptId));
      const kept = lines.filter((line) => line.quantity > 0);
      if (kept.length) await tx.insert(warehouseReceiptLines).values(kept.map((line) => ({ ...line, receiptId })));
      if (done) await moveOrdersToStage(tx, trip.containerId, 6);
      return written[0]!;
    });
    res.json({ receipt });
  });

  return router;
}
