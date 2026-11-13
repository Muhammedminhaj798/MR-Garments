import { and, asc, desc, eq, gt, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { orderedCurrencies } from "../../currencies";
import type { Database } from "../../db/client";
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
import { notify } from "../notifications/notify";
import { atLeast, effectiveAccess } from "../../permissions/matrix";
import { round2, unitSymbol } from "../orders/orders.routes";
import { supplierMoney } from "../reports/reports";
import { moveOrdersToStage, settleStages } from "../stages-shared";
import {
  canSeeCost,
  closed,
  complete,
  containerOrders,
  count,
  goodsIn,
  isUuid,
  lockContainerOrders,
  required,
  STAGE_MESSAGES,
  todayInIndia,
} from "./common";

// Owner: A5. WH-1 GET /warehouse-receipts, WH-2 GET /warehouse-receipts/:transportId, WH-3 PUT
// /warehouse-receipts/:transportId (docs/wave3-contracts.md sections 2, 3 and 5; shapes in section 8), WH-4 DELETE
// /warehouse-receipts/:transportId.
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
  /** Every order in the container must get some of its own pieces before the receipt closes it (docs/phase2-fixes.md 3). */
  noPiecesFor: (po: string) => `${po}: give at least one of its pieces to a team before completing, or save a draft.`,
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
  /** The order's lines on this receipt, all teams together (docs/report-downloads.md): `ordered` is the line's quantity. */
  lines: { orderLineId: string; item: string; unit: string; ordered: number; quantity: number }[];
};

const mainLine = alias(orderLines, "main_line");
const mainItem = alias(items, "main_item");
/** A draft receipt's warehouse, next to the trip's destination. */
const draftLocation = alias(locations, "draft_location");

/** Active teams, plus `extra` (teams already on a saved receipt), in creation order. */
const teamOptions = (db: RouteContext["db"], extra: string[] = []) =>
  db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(or(eq(teams.status, "Active"), extra.length ? inArray(teams.id, extra) : undefined))
    .orderBy(asc(teams.createdAt), asc(teams.name));

/**
 * Previous supplier outstanding, shown beside the cost so far but never part of it: per supplier of the trip's orders,
 * the unpaid balance of its orders placed before the trip (order date before the trip's `loadedOn`, so same-day orders
 * are out) other than the trip's own POs: order value - paid supplier payments (the Payments per supplier rule), per
 * order currency and never converted. Fully paid and overpaid orders are left out. Two queries, none per order.
 */
async function previousOutstanding(db: Database, orderIds: string[], tripDate: string) {
  if (orderIds.length === 0) return [];
  const tripSuppliers = db.select({ id: orders.supplierId }).from(orders).where(inArray(orders.id, orderIds));
  const perOrder = db
    .select({
      supplierId: orders.supplierId,
      currency: orders.currency,
      balance: sql<number>`${supplierMoney.orderValueCny} - ${supplierMoney.paidCny}`.as("balance"),
    })
    .from(orders)
    .where(and(inArray(orders.supplierId, tripSuppliers), notInArray(orders.id, orderIds), lt(orders.orderDate, tripDate)))
    .as("per_order");
  const [owners, owed] = await Promise.all([
    db
      .select({ id: suppliers.id, name: suppliers.name, currency: suppliers.currency })
      .from(suppliers)
      .where(inArray(suppliers.id, tripSuppliers))
      .orderBy(asc(suppliers.name)),
    db
      .select({
        supplierId: perOrder.supplierId,
        currency: perOrder.currency,
        amount: sql<number>`sum(${perOrder.balance})`.mapWith(Number),
        orders: sql<number>`count(*)`.mapWith(Number),
      })
      .from(perOrder)
      .where(gt(perOrder.balance, 0))
      .groupBy(perOrder.supplierId, perOrder.currency),
  ]);
  return owners.map((owner) => {
    const rows = owed.filter((row) => row.supplierId === owner.id);
    return {
      supplierId: owner.id,
      supplier: owner.name,
      currency: owner.currency,
      orders: rows.reduce((total, row) => total + row.orders, 0),
      byCurrency: orderedCurrencies(rows.map((row) => row.currency)).flatMap((currency) => rows.filter((row) => row.currency === currency).map((row) => ({ currency, amount: round2(row.amount) }))),
    };
  });
}

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
          // The receipt's trip and bundles, for the delete confirmation (WH-4).
          lrNumber: transports.lrNumber,
          bundlesReceived: warehouseReceipts.bundlesReceived,
          orderId: orders.id,
          po: orders.poNumber,
          item: mainItem.name,
          supplier: suppliers.name,
          teamId: warehouseReceiptLines.teamId,
          quantity: warehouseReceiptLines.quantity,
          // The line itself and the trip's bundles and remark, for the report download.
          orderLineId: orderLines.id,
          lineItem: items.name,
          lineUnit: unitSymbol,
          ordered: orderLines.quantity,
          bundlesLoaded: transports.bundlesLoaded,
          shortRemark: transports.shortRemark,
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
        .innerJoin(mainItem, eq(mainItem.id, mainLine.itemId))
        .innerJoin(items, eq(items.id, orderLines.itemId))
        .orderBy(desc(warehouseReceipts.receivedOn), desc(warehouseReceipts.createdAt), asc(warehouseReceipts.id), asc(orders.poNumber), asc(orderLines.position)),
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
          // A draft's own values, for the delete confirmation (WH-4).
          draftId: warehouseReceipts.id,
          draftReceivedOn: warehouseReceipts.receivedOn,
          draftBundles: warehouseReceipts.bundlesReceived,
          draftLocation: draftLocation.name,
        })
        .from(transports)
        .innerJoin(containers, eq(containers.id, transports.containerId))
        .innerJoin(locations, eq(locations.id, transports.destinationId))
        .leftJoin(warehouseReceipts, eq(warehouseReceipts.transportId, transports.id))
        .leftJoin(draftLocation, eq(draftLocation.id, warehouseReceipts.locationId))
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

    const draftIds = ready.flatMap((trip) => (trip.draftId ? [trip.draftId] : []));
    const [costs, byContainer, draftLines] = await Promise.all([
      canSeeCost(req.user!) ? loadLandedCosts(db, [...new Set(lines.map((line) => line.orderId))]) : null,
      containerOrders(
        db,
        ready.map((trip) => trip.containerId),
      ),
      draftIds.length
        ? db
            .select({ receiptId: warehouseReceiptLines.receiptId, teamId: warehouseReceiptLines.teamId, quantity: warehouseReceiptLines.quantity })
            .from(warehouseReceiptLines)
            .where(inArray(warehouseReceiptLines.receiptId, draftIds))
        : [],
    ]);
    /** A draft's pieces in all and per team id. */
    const draftSplit = (receiptId: string) => {
      const teamsOf: Record<string, number> = {};
      for (const line of draftLines) if (line.receiptId === receiptId) teamsOf[line.teamId] = (teamsOf[line.teamId] ?? 0) + line.quantity;
      return { received: Object.values(teamsOf).reduce((sum, pieces) => sum + pieces, 0), teams: teamsOf };
    };
    // Lines arrive grouped by receipt and PO, so the rows keep that order.
    type Line = (typeof lines)[number];
    const rows = new Map<string, Omit<Line, "teamId" | "quantity" | "locationId" | "locationName" | "orderLineId" | "lineItem" | "lineUnit" | "ordered"> & RowTotals>();
    for (const { teamId, quantity, locationId, locationName, orderLineId, lineItem, lineUnit, ordered, ...line } of lines) {
      const key = `${line.receiptId}:${line.orderId}`;
      const row = rows.get(key) ?? {
        ...line,
        id: key,
        location: { id: locationId, name: locationName },
        received: 0,
        teams: {},
        costPerPieceInr: costs?.get(line.orderId)?.perPieceInr ?? null,
        lines: [],
      };
      row.received += quantity;
      row.teams[teamId] = (row.teams[teamId] ?? 0) + quantity;
      const own = row.lines.find((entry) => entry.orderLineId === orderLineId);
      if (own) own.quantity += quantity;
      else row.lines.push({ orderLineId, item: lineItem, unit: lineUnit, ordered, quantity });
      rows.set(key, row);
    }
    res.json({
      rows: [...rows.values()],
      ready: ready.map(({ draftId, draftReceivedOn, draftBundles, draftLocation: location, ...trip }) => ({
        ...trip,
        orders: byContainer.get(trip.containerId)?.orders ?? [],
        draft: draftId ? { receivedOn: draftReceivedOn!, location: location!, bundlesReceived: draftBundles!, ...draftSplit(draftId) } : null,
      })),
      teams: teamList,
      warehouses,
    });
  });

  // WH-2. Any trip (the form says when it isn't unloaded). `lines` are the container's lines, the quantities to split.
  router.get("/warehouse-receipts/:transportId", requirePermission("warehouse", "View"), async (req, res) => {
    const id = String(req.params.transportId);
    if (!isUuid(id)) throw notFound("Trip");
    const found = (
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
          loadedOn: transports.loadedOn,
        })
        .from(transports)
        .innerJoin(containers, eq(containers.id, transports.containerId))
        .where(eq(transports.id, id))
    )[0];
    if (!found) throw notFound("Trip");
    // The trip's date (loaded on the truck) is the cutoff of the previous outstanding; the response's trip leaves it out.
    const { loadedOn: tripDate, ...trip } = found;
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
    // Supplier money: only for users who see the cost and payments (Management today).
    const seesOwed = canSeeCost(req.user!) && atLeast(effectiveAccess(req.user!.role, req.user!.stages, "payments"), "View");
    const [teamList, warehouses, costs, ordered, owed] = await Promise.all([
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
      seesOwed ? previousOutstanding(db, orderIds, tripDate) : null,
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
      previousOutstanding: owed,
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
      if (input.complete && !problems.lines) {
        // Stocking moves every order in the container to stage 6 and closes it, so each must have received something of its own.
        const perOrder = new Map<string, number>();
        for (const line of goods) perOrder.set(line.orderId, (perOrder.get(line.orderId) ?? 0) + (split.get(line.orderLineId) ?? 0));
        const empty = goods.find((line) => perOrder.get(line.orderId) === 0);
        if (empty) problems.lines = M.noPiecesFor(empty.po);
      }
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

  // WH-4. Management only (warehouse Full). One transaction: the trip, then its receipt, locked as WH-3 locks them,
  // then the container's orders. Draft or stocked: nothing in the system consumes stocked quantities (no stock movement,
  // dispatch or transfer records exist; landed cost, the lists and reports read the receipt live), so reversing a
  // receipt is removing it with its own team lines. Stock, team totals and cost per piece follow from the remaining
  // records; the trip stays unloaded, waiting to be received again; its orders step back (settleStages: 6 -> 5 unless
  // another of their containers is stocked). Payments, the trip and the clearing are never touched.
  router.delete("/warehouse-receipts/:transportId", requirePermission("warehouse", "Full"), async (req, res) => {
    const id = String(req.params.transportId);
    if (!isUuid(id)) throw notFound("Warehouse receipt");
    const deleted = await db.transaction(async (tx) => {
      const trip = (await tx.select({ containerId: transports.containerId, lr: transports.lrNumber }).from(transports).where(eq(transports.id, id)).for("update"))[0];
      const receipt =
        trip && (await tx.select({ id: warehouseReceipts.id, status: warehouseReceipts.status }).from(warehouseReceipts).where(eq(warehouseReceipts.transportId, id)).for("update"))[0];
      if (!trip || !receipt) throw notFound("Warehouse receipt");
      const orderIds = await lockContainerOrders(tx, trip.containerId);
      const stagesOf = () =>
        orderIds.length ? tx.select({ id: orders.id, po: orders.poNumber, stage: orders.stage }).from(orders).where(inArray(orders.id, orderIds)).orderBy(asc(orders.poNumber)) : [];
      const before = new Map((await stagesOf()).map((row) => [row.id, row.stage]));
      await tx.delete(warehouseReceipts).where(eq(warehouseReceipts.id, receipt.id));
      await settleStages(tx, orderIds);
      // The audit trail (docs/phase2-fixes.md 4): everyone with warehouse access learns which orders stepped back, and
      // the row outlives the server log. Only the orders whose stage fell are named: a draft moves nothing, and an
      // order whose other container is still stocked stays received (settleStages).
      const stepped = (await stagesOf()).filter((row) => row.stage < before.get(row.id)!).map((row) => row.po);
      const container = (await tx.select({ number: containers.number }).from(containers).where(eq(containers.id, trip.containerId)))[0]!;
      await notify(tx, {
        kind: "warehouse-receipt-deleted",
        actorId: req.user!.id,
        sourceId: receipt.id,
        title: `${container.number} warehouse receipt deleted`,
        details: [
          `${receipt.status === "stocked" ? "Stocked" : "Draft"} receipt of trip ${trip.lr}`,
          stepped.length ? `${stepped.join(", ")}: back to an earlier stage` : "No order changed stage",
        ],
        href: () => "/warehouse",
      });
      return { lr: trip.lr, status: receipt.status };
    });
    console.info(`Warehouse receipt (${deleted.status}) of trip ${deleted.lr} (${id}) deleted by user ${req.user!.id}.`);
    res.status(204).end();
  });

  return router;
}
