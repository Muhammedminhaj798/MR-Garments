import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";

import type { Database } from "../../db/client";
import {
  clearings,
  containerLines,
  containers,
  type Currency,
  finalCostProtections,
  orderLines,
  orders,
  payments,
  transports,
  warehouseReceiptLines,
  warehouseReceipts,
} from "../../db/schema";
import { type Ledger, loadLedger, receivedOfLine } from "../ledger/ledger";
import { round2 } from "../orders/money";

// Landed cost per order (docs/wave3-contracts.md sections 6.1-6.2; goods per docs/unified-ledger.md). Coordinator-owned:
// Agents 3, 5 and 6 call loadLandedCosts and never copy it. All amounts are INR with 2 decimals.

export type WaitingFor = "supplier payment" | "duty" | "transport" | "warehouse";

export type OrderLandedCost = {
  orderId: string;
  /** The supplier credits that settled the order (the ledger's FIFO slices), each at its own credit's rate (D12). */
  goodsInr: number;
  /** Paid, not voided payments to an agent (FOB sea freight); 0 when every container carrying the order is CNF. */
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
  /**
   * Goods: one supplier row per settlement slice of the order (the ledger's FIFO projection), at its credit's rate.
   * Sea freight: the order's paid, not voided agent payments. `inr` is rounded to the paisa as PAY-1 rounds it.
   */
  payments: { orderId: string; payeeRole: string; amountCny: number; inr: number }[];
  /**
   * Every container line of every container carrying one of the orders, other orders' lines included (shares).
   * `valueCny` is the loaded quantity x rate in the order's `currency` (the container share's weight).
   */
  loads: { containerId: string; orderId: string; currency: Currency; quantity: number; valueCny: number }[];
  containers: ContainerFacts[];
  /** Pieces on stocked receipts, per order. */
  stocked: { orderId: string; pieces: number }[];
};

type Tally = { goodsInr: number; agentInr: number; supplierCny: number; clearingInr: number | null; transportInr: number | null; carriers: ContainerFacts[]; pieces: number };

/** `balanceCny` is the order value less what the supplier's credits settled of it: agent payments are sea freight, not goods. */
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
  // value is 0 or its orders are in different currencies (values in ¥ and $ don't compare). Rounded per share, so the
  // shares can differ from the container's total by a paisa.
  const shares = new Map<string, Map<string, { value: number; quantity: number }>>();
  const currencies = new Map<string, Set<Currency>>();
  for (const load of facts.loads) {
    currencies.set(load.containerId, (currencies.get(load.containerId) ?? new Set()).add(load.currency));
    const byOrder = shares.get(load.containerId) ?? new Map<string, { value: number; quantity: number }>();
    shares.set(load.containerId, byOrder);
    const share = byOrder.get(load.orderId) ?? { value: 0, quantity: 0 };
    byOrder.set(load.orderId, { value: share.value + load.valueCny, quantity: share.quantity + load.quantity });
  }
  for (const container of facts.containers) {
    const byOrder = [...(shares.get(container.id) ?? [])];
    const byValue = (currencies.get(container.id)?.size ?? 0) <= 1 && byOrder.some(([, share]) => share.value > 0);
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

/** Promise.all, one at a time (a transaction's single connection). */
async function inSequence<T extends readonly unknown[]>(list: T) {
  const done: unknown[] = [];
  for (const item of list) done.push(await item);
  return done as { -readonly [K in keyof T]: Awaited<T[K]> };
}

/**
 * Landed cost of the given orders (every order when omitted), keyed by order id. Five queries whatever the count, plus
 * the ledger of the orders' suppliers unless the caller passes the one it already loaded. Inside a transaction (one
 * connection) pass `inTransaction`: the queries then run one after another, as pg needs, instead of together.
 */
export async function loadLandedCosts(
  db: Pick<Database, "select">,
  orderIds?: string[],
  given?: Ledger,
  { inTransaction = false }: { inTransaction?: boolean } = {},
): Promise<Map<string, OrderLandedCost>> {
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

  const ledgerOf = async () => {
    if (given) return given;
    if (!orderIds) return loadLedger(db);
    const owners = await db.select({ id: orders.supplierId }).from(orders).where(inArray(orders.id, orderIds));
    return loadLedger(db, { supplierIds: [...new Set(owners.map((row) => row.id))] });
  };

  // Drizzle's queries start when awaited: together on a pool, one by one in a transaction.
  const queries = [
    inTransaction ? await ledgerOf() : ledgerOf(),
    // Joined, not a correlated subquery: Drizzle leaves columns unqualified in a select without joins.
    db
      .select({
        id: orders.id,
        stage: orders.stage,
        // The order's value: received quantity x rate (ledger.ts receivedOfLine), as the journal holds it.
        valueCny: sql<number>`round(coalesce(sum(${receivedOfLine} * ${orderLines.rateCny}), 0), 2)`.mapWith(Number),
      })
      .from(orders)
      .leftJoin(orderLines, eq(orderLines.orderId, orders.id))
      .where(of(orders.id))
      .groupBy(orders.id),
    db
      .select({
        // Agent payments always name their order (payments_document_check).
        orderId: sql<string>`${payments.orderId}`,
        payeeRole: payments.payeeRole,
        amountCny: payments.amountCny,
        inr: sql<number>`round(${payments.amountCny} * ${payments.rateInr}, 2)`.mapWith(Number),
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      // A held account's payments (D4) count in no figure: its orders' sea freight leaves them out too.
      .where(and(eq(payments.status, "paid"), eq(payments.payeeRole, "agent"), isNull(payments.voidedAt), of(payments.orderId), sql`not exists (select 1 from supplier_ledger_holds h where h.supplier_id = ${orders.supplierId} and h.currency = ${orders.currency})`)),
    db
      .select({
        containerId: containerLines.containerId,
        orderId: orderLines.orderId,
        currency: orders.currency,
        quantity: containerLines.quantity,
        valueCny: sql<number>`${containerLines.quantity} * ${orderLines.rateCny}`.mapWith(Number),
      })
      .from(containerLines)
      .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
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
  ] as const;
  const [ledger, orderRows, agentRows, loads, containerRows, stocked] = inTransaction ? await inSequence(queries) : await Promise.all(queries);

  // ponytail: a slice whose credit has no rate (legacy NULL) adds no INR; the order's settledInr says null for it.
  const goods = orderRows.flatMap((order) =>
    (ledger.order(order.id)?.slices ?? []).map((slice) => ({ orderId: order.id, payeeRole: "supplier", amountCny: slice.amount, inr: slice.amountInr ?? 0 })),
  );
  return computeLandedCosts({
    orders: orderRows,
    payments: [...agentRows, ...goods],
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

/**
 * Records every order of the account whose landed cost is final now in final_cost_protections (append-only; the same
 * order twice is no change), and returns them. Called by the guard before and after every guarded write, after every
 * supplier payment, and after every clearing, transport and warehouse save (recordFinalCostsOfContainer): whatever
 * completes an order's landed cost records its protection in the same transaction (owner review of 2026-11-23).
 */
export async function recordFinalCosts(db: Pick<Database, "select" | "insert">, supplierId: string, currency: string, ledger?: Ledger) {
  const current = ledger ?? (await loadLedger(db, { supplierIds: [supplierId] }));
  const ids = [...current.orders.values()].filter((row) => row.supplierId === supplierId && row.currency === currency && row.posted && !row.held).map((row) => row.orderId);
  if (ids.length === 0) return [];
  const costs = await loadLandedCosts(db, ids, current, { inTransaction: true });
  const finalNow = ids.filter((id) => costs.get(id)?.final);
  if (finalNow.length > 0) await db.insert(finalCostProtections).values(finalNow.map((orderId) => ({ orderId, supplierId, currency }))).onConflictDoNothing();
  return finalNow;
}

/** The accounts of every order with goods in the container: after a clearing, transport or warehouse save. */
export async function recordFinalCostsOfContainer(db: Pick<Database, "select" | "insert">, containerId: string) {
  const accounts = await db
    .select({ supplierId: orders.supplierId, currency: orders.currency })
    .from(containerLines)
    .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(eq(containerLines.containerId, containerId))
    .groupBy(orders.supplierId, orders.currency);
  for (const account of accounts) await recordFinalCosts(db, account.supplierId, account.currency);
}

/**
 * Pre-release audit M8: an order whose landed cost is final keeps its settlement. A write that can move the account's
 * FIFO order (ORD-3 with a past date, an ORD-5 order-date change, an LED-3 adjustment) takes this before it writes,
 * with the account locked, and calls the returned check after, in the same transaction: the check gives the PO numbers
 * of the final orders whose settling credits or amounts changed (reopened or re-priced), so the caller refuses the
 * write. Empty means no change.
 * Protected for good (owner review of 2026-11-23): every order seen final here is recorded in final_cost_protections
 * (append-only), and the check covers those recorded orders too. So a Management-approved receipt, receipt delete or
 * rate correction that changes a final order's settlement (it may then no longer be final) never removes its
 * protection: every later change to its settlement needs an approval again.
 * ponytail: two projections of the supplier's ledger per such write (a few hundred rows); fine at ORD-3/5 and LED-3 rates.
 * A caller that already projected the supplier's ledger (locked, before the write; after it) passes it: PAY-4's legacy
 * correction compares the same two projections itself.
 */
export async function guardFinalSettlements(db: Pick<Database, "select" | "insert">, supplierId: string, currency: string, given?: Ledger) {
  const slicesOf = (ledger: Ledger, id: string) => JSON.stringify(ledger.order(id)?.slices.map((slice) => [slice.entryId, slice.amount]) ?? null);
  const before = given ?? (await loadLedger(db, { supplierIds: [supplierId] }));
  const ids = [...before.orders.values()].filter((row) => row.currency === currency && row.posted).map((row) => row.orderId);
  const finalNow = await recordFinalCosts(db, supplierId, currency, before);
  const recorded = await db
    .select({ orderId: finalCostProtections.orderId })
    .from(finalCostProtections)
    .where(and(eq(finalCostProtections.supplierId, supplierId), eq(finalCostProtections.currency, currency)));
  const final = [...new Set([...finalNow, ...recorded.map((row) => row.orderId)])].filter((id) => ids.includes(id));
  return async (givenAfter?: Ledger) => {
    const after = givenAfter ?? (await loadLedger(db, { supplierIds: [supplierId] }));
    // The write may itself complete an order (a payment settling its last part): protected from that moment.
    await recordFinalCosts(db, supplierId, currency, after);
    if (final.length === 0) return [];
    const changed = final.filter((id) => slicesOf(before, id) !== slicesOf(after, id));
    if (changed.length === 0) return [];
    const rows = await db.select({ po: orders.poNumber }).from(orders).where(inArray(orders.id, changed)).orderBy(orders.orderDate, orders.poNumber);
    return rows.map((row) => row.po);
  };
}
