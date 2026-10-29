import { asc, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { containerLines, containers, items, orderLines, orders, shippingAgents } from "../../db/schema";
import { conflict, GENERIC_MESSAGE, HttpError, notFound, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { day, notify } from "../notifications/notify";
import { MESSAGES } from "./stock.routes";

// Owner: BE-containers. CON-4 GET /containers/:id, CON-5 PATCH /containers/:id (docs/live-screens-contracts.md,
// "Five-tab completion").

export const DETAIL_MESSAGES = {
  arrived: "This container has arrived and can't be changed.",
  invalidStatusChange: "Containers move from Loading to At sea to Arrived, in that order.",
  // Proposed wording (the contract names only the fields).
  status: "Choose At sea or Arrived.",
  sailedOnNeeded: "Enter the sailing date.",
  sailedBeforeLoading: "The sailing date can't be before the loading date.",
  sailedFuture: "The sailing date can't be after today.",
  etaBeforeLoading: MESSAGES.etaBeforeLoading,
  etaBeforeSailing: "The ETA can't be before the sailing date.",
};

// Copied from stock.routes.ts (private there).
const unit = (countedIn: string) => (countedIn === "Metres" ? "m" : "pcs");
/** Today in India (Asia/Kolkata, UTC+5:30, no daylight saving) as YYYY-MM-DD. */
const todayInIndia = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const isUuid = (value: string) => z.uuid().safeParse(value).success;

const update = z.strictObject({
  status: z.enum(["sea", "arrived"], { error: DETAIL_MESSAGES.status }).optional(),
  sailedOn: z.iso.date({ error: MESSAGES.sailedOn }).optional(),
  eta: z.iso.date({ error: MESSAGES.eta }).optional(),
});

const NEXT_STATUS: Record<string, string> = { loading: "sea", sea: "arrived" };

export function containerDetailRoutes({ db }: RouteContext) {
  const router = Router();

  // CON-4. The CON-1 fields (bundles, orders with `part`) plus ports and this container's lines, PO then item.
  router.get("/containers/:id", requirePermission("containers", "View"), async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Container");
    const row = (
      await db
        .select({
          id: containers.id,
          number: containers.number,
          agent: { id: shippingAgents.id, name: shippingAgents.name },
          terms: containers.terms,
          loadedOn: containers.loadedOn,
          sailedOn: containers.sailedOn,
          eta: containers.eta,
          etaEstimated: containers.etaEstimated,
          status: containers.status,
          portOfLoading: containers.portOfLoading,
          portOfArrival: containers.portOfArrival,
        })
        .from(containers)
        .innerJoin(shippingAgents, eq(shippingAgents.id, containers.shippingAgentId))
        .where(eq(containers.id, id))
    )[0];
    if (!row) throw notFound("Container");
    const lines = await db
      .select({
        orderLineId: containerLines.orderLineId,
        orderId: orderLines.orderId,
        po: orders.poNumber,
        item: items.name,
        countedIn: items.countedIn,
        bundles: containerLines.bundles,
        quantity: containerLines.quantity,
      })
      .from(containerLines)
      .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
      .innerJoin(items, eq(items.id, orderLines.itemId))
      .where(eq(containerLines.containerId, id))
      .orderBy(asc(orders.poNumber), asc(items.name));
    const pos = new Map(lines.map((line) => [line.orderId, line.po]));
    const ordered = pos.size
      ? await db.select({ id: orderLines.id, orderId: orderLines.orderId, quantity: orderLines.quantity }).from(orderLines).where(inArray(orderLines.orderId, [...pos.keys()]))
      : [];
    const inThis = new Map(lines.map((line) => [line.orderLineId, line.quantity]));
    res.json({
      ...row,
      bundles: lines.reduce((sum, line) => sum + line.bundles, 0),
      orders: [...pos].map(([orderId, po]) => ({
        po,
        part: ordered.some((line) => line.orderId === orderId && (inThis.get(line.id) ?? 0) < line.quantity),
      })),
      lines: lines.map(({ countedIn, ...line }) => ({ ...line, unit: unit(countedIn) })),
    });
  });

  // CON-5. One transaction with the container row locked; forward only. Order stages are not touched.
  router.patch("/containers/:id", requirePermission("containers", "Enter"), async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Container");
    const input = parse(update, req.body);
    if (Object.keys(input).length === 0) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);

    const container = await db.transaction(async (tx) => {
      const row = (await tx.select().from(containers).where(eq(containers.id, id)).for("update"))[0];
      if (!row) throw notFound("Container");
      if (row.status === "arrived") throw conflict("container_arrived", DETAIL_MESSAGES.arrived);
      if (input.status && NEXT_STATUS[row.status] !== input.status) {
        throw conflict("invalid_status_change", DETAIL_MESSAGES.invalidStatusChange);
      }

      // Date rules apply to what this request sets: a sailing date sent, or the saved one when moving to sea.
      const sailedOn = input.sailedOn ?? row.sailedOn;
      const eta = input.eta ?? row.eta;
      const checkSailing = input.sailedOn !== undefined || input.status === "sea";
      const problems: Record<string, string> = {};
      if (checkSailing) {
        if (!sailedOn) problems.sailedOn = DETAIL_MESSAGES.sailedOnNeeded;
        else if (row.loadedOn && sailedOn < row.loadedOn) problems.sailedOn = DETAIL_MESSAGES.sailedBeforeLoading;
        else if (sailedOn > todayInIndia()) problems.sailedOn = DETAIL_MESSAGES.sailedFuture;
      }
      if (input.eta !== undefined || checkSailing) {
        if (row.loadedOn && eta < row.loadedOn) problems.eta = DETAIL_MESSAGES.etaBeforeLoading;
        else if (sailedOn && eta < sailedOn) problems.eta = DETAIL_MESSAGES.etaBeforeSailing;
      }
      if (Object.keys(problems).length > 0) throw validationFailed(problems);

      const saved = (
        await tx
          .update(containers)
          .set(input)
          .where(eq(containers.id, id))
          .returning({ id: containers.id, status: containers.status, sailedOn: containers.sailedOn, eta: containers.eta })
      )[0]!;
      if (input.status) {
        const pos = await tx
          .selectDistinct({ po: orders.poNumber })
          .from(containerLines)
          .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
          .innerJoin(orders, eq(orders.id, orderLines.orderId))
          .where(eq(containerLines.containerId, id))
          .orderBy(asc(orders.poNumber));
        const sailed = input.status === "sea";
        await notify(tx, {
          kind: sailed ? "container-sailed" : "container-arrived",
          capability: "containers",
          actorId: req.user!.id,
          sourceId: id,
          title: `Container ${row.number} ${sailed ? "sailed" : "arrived"}`,
          details: [pos.map((line) => line.po).join(", "), sailed ? `ETA ${day(saved.eta)}` : row.portOfArrival].filter(Boolean),
          href: () => `/containers/${id}`,
        });
      }
      return saved;
    });
    res.json({ container });
  });

  return router;
}
