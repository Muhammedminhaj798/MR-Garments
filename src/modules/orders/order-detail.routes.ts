import { asc, eq, inArray, sql } from "drizzle-orm";
import { Router } from "express";

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
} from "../../db/schema";
import { notFound } from "../../http/errors";
import { atLeast, type Capability, effectiveAccess } from "../../permissions/matrix";
import type { RouteContext } from "../context";
import { orderRows, round2, unit } from "./orders.routes";

// Owner: BE-orders. ORD-4 GET /orders/:po (docs/live-screens-contracts.md, "Five-tab completion").

const PO = /^PO-\d+$/;
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

  return router;
}
