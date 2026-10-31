import { and, asc, count, countDistinct, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import {
  containerLines,
  containers,
  items,
  locations,
  orderLines,
  orders,
  payments,
  receiptLines,
  receipts,
  shippingAgents,
  suppliers,
  users,
  warehouseReceiptLines,
} from "../../db/schema";
import { conflict, GENERIC_MESSAGE, HttpError, notFound, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import { atLeast, type Capability, effectiveAccess } from "../../permissions/matrix";
import type { RouteContext } from "../context";
import { line, lineList, MESSAGES as M, orderRows, round2, unit } from "./orders.routes";

// Owner: BE-orders. ORD-4 GET /orders/:po (docs/live-screens-contracts.md, "Five-tab completion"); ORD-5 PATCH and
// ORD-6 DELETE /orders/:po (docs/contracts.md, "Orders: edit and delete").

const PO = /^PO-\d+$/;
const EDIT = {
  warehouse: "This order has reached the warehouse, so it can't be changed.",
  received: "Goods have been received for this order, so only the delivery date can change.",
  lineChanged: "A line on this order changed. Reload the order and try again.",
  belowPaid: (paid: number) =>
    `The order total can't be less than the ¥${paid.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} already paid.`,
};
const orderEdit = z.strictObject({
  orderDate: z.iso.date({ error: M.orderDate }).optional(),
  deliveryDate: z.iso.date({ error: M.deliveryDate }).optional(),
  lines: lineList(line.extend({ id: z.uuid({ error: EDIT.lineChanged }).optional() })).optional(),
});
const joined = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]!);
const received = sql<number>`(select coalesce(sum(${receiptLines.quantity}), 0) from ${receiptLines} where ${receiptLines.orderLineId} = ${orderLines.id})`.mapWith(Number);
const loaded = sql<number>`(select coalesce(sum(${containerLines.quantity}), 0) from ${containerLines} where ${containerLines.orderLineId} = ${orderLines.id})`.mapWith(Number);

export function orderDetailRoutes({ db }: RouteContext) {
  const router = Router();

  router.get("/orders/:po", requirePermission("ordersView", "View"), async (req, res) => {
    const po = String(req.params.po);
    const row = PO.test(po) ? (await orderRows(db, [], eq(orders.poNumber, po)))[0] : undefined;
    if (!row) throw notFound("Order");
    const orderId = row.id;
    const { role, stages } = req.user!;
    // A section the user can't view is null (effective access below View), and its query never runs.
    const section = <T>(capability: Capability, query: () => Promise<T>) =>
      atLeast(effectiveAccess(role, stages, capability), "View") ? query() : Promise.resolve(null);

    const [supplier, lines, paymentList, receiptList, containerList] = await Promise.all([
      db
        .select({ contactPerson: suppliers.contactPerson, phone: suppliers.phone, city: suppliers.city })
        .from(suppliers)
        .where(eq(suppliers.id, row.supplierId)),
      db
        .select({
          id: orderLines.id,
          position: orderLines.position,
          itemId: items.id,
          itemName: items.name,
          countedIn: items.countedIn,
          quantity: orderLines.quantity,
          rateCny: orderLines.rateCny,
          valueCny: sql<number>`round(${orderLines.quantity} * ${orderLines.rateCny}, 2)`.mapWith(Number),
          received,
          loaded,
        })
        .from(orderLines)
        .innerJoin(items, eq(items.id, orderLines.itemId))
        .where(eq(orderLines.orderId, orderId))
        .orderBy(asc(orderLines.position)),
      section("payments", () =>
        db
          .select({
            id: payments.id,
            kind: payments.kind,
            payee: payments.payee,
            payeeRole: payments.payeeRole,
            amountCny: payments.amountCny,
            status: payments.status,
            paidOn: payments.paidOn,
            dueDate: payments.dueDate,
            rateInr: payments.rateInr,
            mode: payments.mode,
          })
          .from(payments)
          .where(eq(payments.orderId, orderId))
          .orderBy(asc(sql`coalesce(${payments.paidOn}, ${payments.dueDate})`), asc(payments.createdAt)),
      ),
      section("receiving", async () => {
        const [list, lineList] = await Promise.all([
          db
            .select({
              id: receipts.id,
              receivedOn: receipts.receivedOn,
              office: locations.name,
              bundles: receipts.bundles,
              deliveryNote: receipts.deliveryNote,
              shortRemark: receipts.shortRemark,
              receivedBy: sql<string>`coalesce(${users.name}, '')`,
            })
            .from(receipts)
            .innerJoin(locations, eq(locations.id, receipts.locationId))
            .leftJoin(users, eq(users.id, receipts.receivedBy))
            .where(eq(receipts.orderId, orderId))
            .orderBy(asc(receipts.receivedOn), asc(receipts.createdAt)),
          db
            .select({
              receiptId: receiptLines.receiptId,
              orderLineId: receiptLines.orderLineId,
              item: items.name,
              countedIn: items.countedIn,
              quantity: receiptLines.quantity,
            })
            .from(receiptLines)
            .innerJoin(orderLines, eq(orderLines.id, receiptLines.orderLineId))
            .innerJoin(items, eq(items.id, orderLines.itemId))
            .where(eq(orderLines.orderId, orderId))
            .orderBy(asc(orderLines.position)),
        ]);
        return list.map((receipt) => ({
          ...receipt,
          lines: lineList
            .filter((line) => line.receiptId === receipt.id)
            .map((line) => ({ orderLineId: line.orderLineId, item: line.item, unit: unit(line.countedIn), quantity: line.quantity })),
        }));
      }),
      section("containers", async () => {
        // Only this order's lines; a container shared with other orders shows just this order's goods.
        const lineList = await db
          .select({
            containerId: containerLines.containerId,
            orderLineId: containerLines.orderLineId,
            item: items.name,
            countedIn: items.countedIn,
            bundles: containerLines.bundles,
            quantity: containerLines.quantity,
          })
          .from(containerLines)
          .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
          .innerJoin(items, eq(items.id, orderLines.itemId))
          .where(eq(orderLines.orderId, orderId))
          .orderBy(asc(orderLines.position));
        if (lineList.length === 0) return [];
        const list = await db
          .select({
            id: containers.id,
            number: containers.number,
            status: containers.status,
            terms: containers.terms,
            agentId: shippingAgents.id,
            agentName: shippingAgents.name,
            loadedOn: containers.loadedOn,
            sailedOn: containers.sailedOn,
            eta: containers.eta,
          })
          .from(containers)
          .innerJoin(shippingAgents, eq(shippingAgents.id, containers.shippingAgentId))
          .where(inArray(containers.id, [...new Set(lineList.map((line) => line.containerId))]))
          .orderBy(asc(containers.loadedOn), asc(containers.createdAt));
        return list.map(({ agentId, agentName, ...container }) => ({
          ...container,
          agent: { id: agentId, name: agentName },
          lines: lineList
            .filter((line) => line.containerId === container.id)
            .map((line) => ({ orderLineId: line.orderLineId, item: line.item, unit: unit(line.countedIn), bundles: line.bundles, quantity: line.quantity })),
        }));
      }),
    ]);

    res.json({
      id: row.id,
      po: row.po,
      orderDate: row.orderDate,
      deliveryDate: row.deliveryDate,
      stage: row.stage,
      supplier: { id: row.supplierId, name: row.supplierName, ...supplier[0]! },
      item: row.item,
      quantity: row.quantity,
      unit: unit(row.countedIn),
      received: row.received,
      orderValueCny: row.orderValueCny,
      paidCny: row.paidCny,
      paidInr: row.paidInr,
      balanceCny: round2(row.orderValueCny - row.paidCny),
      lines: lines.map(({ itemId, itemName, countedIn, ...line }) => ({ ...line, item: { id: itemId, name: itemName }, unit: unit(countedIn) })),
      payments: paymentList,
      receipts: receiptList,
      containers: containerList,
    });
  });

  // ORD-5. One transaction with the order row locked: REC-3 and CON-3 lock it too, and a new payment's foreign key
  // key-share locks it, so no receipt, load or payment can land between the checks below and the change.
  router.patch("/orders/:po", requirePermission("ordersEdit", "Enter"), async (req, res) => {
    const po = String(req.params.po);
    if (!PO.test(po)) throw notFound("Order");
    const input = parse(orderEdit, req.body);
    if (Object.keys(input).length === 0) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);

    const order = await db.transaction(async (tx) => {
      const row = (await tx.select().from(orders).where(eq(orders.poNumber, po)).for("update"))[0];
      if (!row) throw notFound("Order");
      if (row.stage === 6) throw conflict("order_locked", EDIT.warehouse);
      const headerOrLines = input.orderDate !== undefined || input.lines !== undefined;
      if (row.stage > 1 && headerOrLines) throw conflict("order_locked", EDIT.received);
      // Defence in depth: a receipt moves an order to stage 2 in the same locked transaction, so through the API a stage-1
      // order has no goods. If the data ever says otherwise (an import, a manual fix), treat the order as received: a
      // removed line would otherwise cascade its receipt, container or warehouse lines away.
      if (headerOrLines) {
        const lineIds = tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, row.id));
        const goods =
          (await tx.select({ n: count() }).from(receiptLines).where(inArray(receiptLines.orderLineId, lineIds)))[0]!.n +
          (await tx.select({ n: count() }).from(containerLines).where(inArray(containerLines.orderLineId, lineIds)))[0]!.n +
          (await tx.select({ n: count() }).from(warehouseReceiptLines).where(inArray(warehouseReceiptLines.orderLineId, lineIds)))[0]!.n;
        if (goods > 0) throw conflict("order_locked", EDIT.received);
      }

      const problems: Record<string, string> = {};
      if ((input.deliveryDate ?? row.deliveryDate) < (input.orderDate ?? row.orderDate)) problems.deliveryDate = M.deliveryBeforeOrder;
      const kept = (input.lines ?? []).flatMap((entry) => (entry.id ? [entry.id] : []));
      if (input.lines) {
        const saved = await tx.select({ id: orderLines.id, itemId: orderLines.itemId }).from(orderLines).where(eq(orderLines.orderId, row.id));
        const savedItem = new Map(saved.map((entry) => [entry.id, entry.itemId]));
        // A line that keeps its saved item is not re-checked, so an item made inactive since doesn't block the edit.
        const itemIds = [...new Set(input.lines.filter((entry) => !entry.id || savedItem.get(entry.id) !== entry.itemId).map((entry) => entry.itemId))];
        const active = itemIds.length
          ? await tx.select({ id: items.id }).from(items).where(and(inArray(items.id, itemIds), eq(items.status, "Active")))
          : [];
        // ponytail: float total rounded like round2 elsewhere; compare as SQL numeric if a cent-edge case ever matters.
        const total = round2(input.lines.reduce((sum, entry) => sum + entry.quantity * entry.rateCny, 0));
        const paid = (
          await tx
            .select({ cny: sql<number>`coalesce(sum(${payments.amountCny}), 0)`.mapWith(Number) })
            .from(payments)
            .where(and(eq(payments.orderId, row.id), eq(payments.status, "paid")))
        )[0]!.cny;
        if (kept.some((id) => !savedItem.has(id)) || new Set(kept).size < kept.length) problems.lines = EDIT.lineChanged;
        else if (active.length < itemIds.length) problems.lines = M.item;
        else if (total < paid) problems.lines = EDIT.belowPaid(paid);
      }
      if (Object.keys(problems).length > 0) throw validationFailed(problems);

      if (input.lines) {
        await tx.delete(orderLines).where(and(eq(orderLines.orderId, row.id), kept.length ? notInArray(orderLines.id, kept) : undefined));
        // (order, position) is unique and checked row by row, so kept lines step out of 0-49 before taking their places.
        await tx.update(orderLines).set({ position: sql`${orderLines.position} + 100` }).where(eq(orderLines.orderId, row.id));
        const added: (typeof orderLines.$inferInsert)[] = [];
        for (const [position, { id, ...values }] of input.lines.entries()) {
          if (id) await tx.update(orderLines).set({ ...values, position }).where(eq(orderLines.id, id));
          else added.push({ ...values, orderId: row.id, position });
        }
        if (added.length > 0) await tx.insert(orderLines).values(added);
      }
      const updated = await tx
        .update(orders)
        .set({ orderDate: input.orderDate, deliveryDate: input.deliveryDate, updatedAt: new Date() })
        .where(eq(orders.id, row.id))
        .returning({ id: orders.id, po: orders.poNumber, stage: orders.stage, orderDate: orders.orderDate, deliveryDate: orders.deliveryDate });
      return updated[0]!;
    });
    res.json({ order });
  });

  // ORD-6. Only an order nothing depends on is deleted, with its own lines (the order_lines cascade). The order and its
  // lines are locked first: REC-3 and CON-3 lock the order, and any new payment, receipt, container or warehouse line
  // key-share locks the row it names, so nothing can start depending on the order between the counts and the delete.
  router.delete("/orders/:po", requirePermission("admin", "Full"), async (req, res) => {
    const po = String(req.params.po);
    if (!PO.test(po)) throw notFound("Order");
    const inUse = (what: string) => conflict("in_use", `This order has ${what}, so it can't be deleted.`);
    await db
      .transaction(async (tx) => {
        const row = (await tx.select({ id: orders.id }).from(orders).where(eq(orders.poNumber, po)).for("update"))[0];
        if (!row) throw notFound("Order");
        await tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, row.id)).for("update");
        const lines = tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, row.id));
        const receiptsWithLines = tx.select({ id: receiptLines.receiptId }).from(receiptLines).where(inArray(receiptLines.orderLineId, lines));
        // Every foreign key to orders and order_lines cascades, so each kind of dependent is counted here.
        const uses: [string, PromiseLike<{ n: number }[]>][] = [
          ["payment", tx.select({ n: count() }).from(payments).where(eq(payments.orderId, row.id))],
          ["receipt", tx.select({ n: countDistinct(receipts.id) }).from(receipts).where(or(eq(receipts.orderId, row.id), inArray(receipts.id, receiptsWithLines)))],
          ["container", tx.select({ n: countDistinct(containerLines.containerId) }).from(containerLines).where(inArray(containerLines.orderLineId, lines))],
          [
            "warehouse receipt",
            tx.select({ n: countDistinct(warehouseReceiptLines.receiptId) }).from(warehouseReceiptLines).where(inArray(warehouseReceiptLines.orderLineId, lines)),
          ],
        ];
        const used: string[] = [];
        for (const [what, query] of uses) {
          const n = (await query)[0]!.n;
          if (n > 0) used.push(`${n} ${what}${n === 1 ? "" : "s"}`);
        }
        if (used.length > 0) throw inUse(joined(used));
        await tx.delete(orders).where(eq(orders.id, row.id));
      })
      .catch((error: unknown) => {
        // A use the counts missed through a NO ACTION foreign key refuses the delete (none exists today).
        type PgError = { code?: string; cause?: PgError };
        if (((error as PgError)?.cause ?? (error as PgError))?.code === "23503") throw inUse("other records");
        throw error;
      });
    res.status(204).end();
  });

  return router;
}
