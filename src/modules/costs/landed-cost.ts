import { and, eq, inArray, sql } from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";

import type { Database } from "../../db/client";
import {
  clearings,
  containerLines,
  containers,
  orderLines,
  orders,
  payments,
  transports,
  warehouseReceiptLines,
  warehouseReceipts,
} from "../../db/schema";
import { round2 } from "../orders/orders.routes";

// Landed cost per order (docs/wave3-contracts.md sections 6.1-6.2). Coordinator-owned: Agents 3, 5 and 6 call
// loadLandedCosts and never copy it. All amounts are INR with 2 decimals.

export type WaitingFor = "supplier payment" | "duty" | "transport" | "warehouse";

export type OrderLandedCost = {
  orderId: string;
  /** Paid payments to the supplier, each at its own rateInr. */
  goodsInr: number;
  /** Paid payments to an agent (FOB sea freight); 0 when every container carrying the order is CNF. */
  seaFreightInr: number;
  /** Allocated clearing charges; null until a container of this order has a clearing. */
  clearingInr: number | null;
  /** Allocated freight + handling; null until a container of this order has a trip. */
  transportInr: number | null;
  totalInr: number;
  /** Quantity given to teams on stocked receipts (metres and pieces added together). */
  stockedPieces: number;
  /** totalInr / stockedPieces, null while nothing is stocked. One average for every line of the order. */
  perPieceInr: number | null;
  final: boolean;
  /** The first missing part, null when final. */
  waitingFor: WaitingFor | null;
};

type ContainerFacts = {
  id: string;
  terms: string;
  /** The four clearing charges; null without a clearing. */
  clearingInr: number | null;
  cleared: boolean;
  /** Freight + handling; null without a trip. */
  tripInr: number | null;
  unloaded: boolean;
  stocked: boolean;
};

/** What computeLandedCosts works from, as loadLandedCosts reads it. */
export type LandedCostFacts = {
  orders: { id: string; stage: number; valueCny: number }[];
  /** Paid payments only. `inr` is round2(amountCny * rateInr), rounded in SQL so it matches PAY-1 to the paisa. */
  payments: { orderId: string; payeeRole: string; amountCny: number; inr: number }[];
  /** Every container line of every container carrying one of the orders, other orders' lines included (shares). */
  loads: { containerId: string; orderId: string; quantity: number; valueCny: number }[];
  containers: ContainerFacts[];
  /** Pieces on stocked receipts, per order. */
  stocked: { orderId: string; pieces: number }[];
};

type Tally = { goodsInr: number; agentInr: number; supplierCny: number; clearingInr: number | null; transportInr: number | null; carriers: ContainerFacts[]; pieces: number };

/** `balanceCny` is the order value less paid supplier payments: agent payments are sea freight, not goods. */
function waitingFor(balanceCny: number, stage: number, carriers: ContainerFacts[]): WaitingFor | null {
  if (balanceCny > 0) return "supplier payment";
  if (carriers.length === 0 || carriers.some((container) => !container.cleared)) return "duty";
  if (carriers.some((container) => !container.unloaded)) return "transport";
  if (stage < 6 || carriers.some((container) => !container.stocked)) return "warehouse";
  return null;
}

/** Pure: one OrderLandedCost per order in `facts.orders`, in that order. */
export function computeLandedCosts(facts: LandedCostFacts): Map<string, OrderLandedCost> {
  const tallies = new Map<string, Tally>(
    facts.orders.map((order) => [order.id, { goodsInr: 0, agentInr: 0, supplierCny: 0, clearingInr: null, transportInr: null, carriers: [], pieces: 0 }]),
  );
  for (const payment of facts.payments) {
    const tally = tallies.get(payment.orderId);
    if (!tally) continue;
    if (payment.payeeRole === "supplier") {
      tally.goodsInr += payment.inr;
      tally.supplierCny += payment.amountCny;
    } else tally.agentInr += payment.inr;
  }
  for (const { orderId, pieces } of facts.stocked) {
    const tally = tallies.get(orderId);
    if (tally) tally.pieces += pieces;
  }

  // Each order's share of a container: its goods value there (quantity * rateCny), or its quantity when the container's
  // value is 0. Rounded per share, so the shares can differ from the container's total by a paisa.
  const shares = new Map<string, Map<string, { value: number; quantity: number }>>();
  for (const load of facts.loads) {
    const byOrder = shares.get(load.containerId) ?? new Map<string, { value: number; quantity: number }>();
    shares.set(load.containerId, byOrder);
    const share = byOrder.get(load.orderId) ?? { value: 0, quantity: 0 };
    byOrder.set(load.orderId, { value: share.value + load.valueCny, quantity: share.quantity + load.quantity });
  }
  for (const container of facts.containers) {
    const byOrder = [...(shares.get(container.id) ?? [])];
    const byValue = byOrder.some(([, share]) => share.value > 0);
    const weight = (share: { value: number; quantity: number }) => (byValue ? share.value : share.quantity);
    const whole = byOrder.reduce((sum, [, share]) => sum + weight(share), 0);
    for (const [orderId, share] of byOrder) {
      const tally = tallies.get(orderId);
      if (!tally) continue;
      tally.carriers.push(container);
      if (container.clearingInr !== null) tally.clearingInr = (tally.clearingInr ?? 0) + round2((container.clearingInr * weight(share)) / whole);
      if (container.tripInr !== null) tally.transportInr = (tally.transportInr ?? 0) + round2((container.tripInr * weight(share)) / whole);
    }
  }

  const costs = new Map<string, OrderLandedCost>();
  for (const order of facts.orders) {
    const tally = tallies.get(order.id)!;
    const cnf = tally.carriers.length > 0 && tally.carriers.every((container) => container.terms === "CNF");
    const goodsInr = round2(tally.goodsInr);
    const seaFreightInr = cnf ? 0 : round2(tally.agentInr);
    const clearingInr = tally.clearingInr === null ? null : round2(tally.clearingInr);
    const transportInr = tally.transportInr === null ? null : round2(tally.transportInr);
    const totalInr = round2(goodsInr + seaFreightInr + (clearingInr ?? 0) + (transportInr ?? 0));
    const missing = waitingFor(round2(order.valueCny - tally.supplierCny), order.stage, tally.carriers);
    costs.set(order.id, {
      orderId: order.id,
      goodsInr,
      seaFreightInr,
      clearingInr,
      transportInr,
      totalInr,
      stockedPieces: tally.pieces,
      perPieceInr: tally.pieces > 0 ? round2(totalInr / tally.pieces) : null,
      final: missing === null,
      waitingFor: missing,
    });
  }
  return costs;
}

/** Landed cost of the given orders (every order when omitted), keyed by order id. Five queries, whatever the count. */
export async function loadLandedCosts(db: Pick<Database, "select">, orderIds?: string[]): Promise<Map<string, OrderLandedCost>> {
  if (orderIds?.length === 0) return new Map();
  const of = (column: PgColumn) => (orderIds ? inArray(column, orderIds) : undefined);
  // The containers carrying the orders; every container when no orders are given.
  const carrying = alias(containerLines, "carrying");
  const carryingLine = alias(orderLines, "carrying_line");
  const carriers = db
    .select({ id: carrying.containerId })
    .from(carrying)
    .innerJoin(carryingLine, eq(carryingLine.id, carrying.orderLineId))
    .where(of(carryingLine.orderId));

  const [orderRows, paymentRows, loads, containerRows, stocked] = await Promise.all([
    // Joined, not a correlated subquery: Drizzle leaves columns unqualified in a select without joins.
    db
      .select({
        id: orders.id,
        stage: orders.stage,
        valueCny: sql<number>`round(coalesce(sum(${orderLines.quantity} * ${orderLines.rateCny}), 0), 2)`.mapWith(Number),
      })
      .from(orders)
      .leftJoin(orderLines, eq(orderLines.orderId, orders.id))
      .where(of(orders.id))
      .groupBy(orders.id),
    db
      .select({
        orderId: payments.orderId,
        payeeRole: payments.payeeRole,
        amountCny: payments.amountCny,
        inr: sql<number>`round(${payments.amountCny} * ${payments.rateInr}, 2)`.mapWith(Number),
      })
      .from(payments)
      .where(and(eq(payments.status, "paid"), of(payments.orderId))),
    db
      .select({
        containerId: containerLines.containerId,
        orderId: orderLines.orderId,
        quantity: containerLines.quantity,
        valueCny: sql<number>`${containerLines.quantity} * ${orderLines.rateCny}`.mapWith(Number),
      })
      .from(containerLines)
      .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
      .where(inArray(containerLines.containerId, carriers)),
    db
      .select({
        id: containers.id,
        terms: containers.terms,
        clearingInr: sql<number | null>`${clearings.customsDutyInr} + ${clearings.otherDutiesInr} + ${clearings.agentChargesInr} + ${clearings.portChargesInr}`.mapWith(
          Number,
        ),
        clearingStatus: clearings.status,
        tripInr: sql<number | null>`${transports.freightInr} + ${transports.handlingInr}`.mapWith(Number),
        tripStatus: transports.status,
        receiptStatus: warehouseReceipts.status,
      })
      .from(containers)
      .leftJoin(clearings, eq(clearings.containerId, containers.id))
      .leftJoin(transports, eq(transports.containerId, containers.id))
      .leftJoin(warehouseReceipts, eq(warehouseReceipts.transportId, transports.id))
      .where(inArray(containers.id, carriers)),
    db
      .select({ orderId: orderLines.orderId, pieces: sql<number>`sum(${warehouseReceiptLines.quantity})`.mapWith(Number) })
      .from(warehouseReceiptLines)
      .innerJoin(warehouseReceipts, and(eq(warehouseReceipts.id, warehouseReceiptLines.receiptId), eq(warehouseReceipts.status, "stocked")))
      .innerJoin(orderLines, eq(orderLines.id, warehouseReceiptLines.orderLineId))
      .where(of(orderLines.orderId))
      .groupBy(orderLines.orderId),
  ]);

  return computeLandedCosts({
    orders: orderRows,
    payments: paymentRows,
    loads,
    containers: containerRows.map(({ clearingStatus, tripStatus, receiptStatus, ...container }) => ({
      ...container,
      cleared: clearingStatus === "cleared",
      unloaded: tripStatus === "unloaded",
      stocked: receiptStatus === "stocked",
    })),
    stocked,
  });
}
