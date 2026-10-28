import { and, asc, desc, eq, gte, lt, lte, type SQL, sql } from "drizzle-orm";

import type { Database } from "../../db/client";
import {
  clearings,
  containerLines,
  containers,
  items,
  orderLines,
  orders,
  payments,
  receiptLines,
  receipts,
  suppliers,
  transports,
  warehouseReceipts,
} from "../../db/schema";
import { loadLandedCosts } from "../costs/landed-cost";
import { round2, unit } from "../orders/orders.routes";

// The seven reports behind GET /reports/<name> (docs/wave3-contracts.md sections 7 and 8). Each takes the optional
// filters and today in India, and returns its JSON body. Shapes are recorded in section 8.

export type Filters = { from?: string; to?: string; supplierId?: string };

/** Today in India (Asia/Kolkata, UTC+5:30, no daylight saving) as YYYY-MM-DD. */
export const todayInIndia = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
/** `day` (YYYY-MM-DD) moved by `days`. */
export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;
const sum = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);

/** Order-based reports keep the orders placed in the period (order date) with the supplier. */
const orderFilter = (f: Filters) =>
  and(f.from ? gte(orders.orderDate, f.from) : undefined, f.to ? lte(orders.orderDate, f.to) : undefined, f.supplierId ? eq(orders.supplierId, f.supplierId) : undefined);

/** Orders at stage 6 with the day their last stocked warehouse receipt was received: the day they reached the warehouse. */
function finishedOrders(db: Database, where?: SQL) {
  return db
    .select({ id: orders.id, orderDate: orders.orderDate, finishedOn: sql<string>`max(${warehouseReceipts.receivedOn})::text`.as("finished_on") })
    .from(orders)
    .innerJoin(orderLines, eq(orderLines.orderId, orders.id))
    .innerJoin(containerLines, eq(containerLines.orderLineId, orderLines.id))
    .innerJoin(transports, eq(transports.containerId, containerLines.containerId))
    .innerJoin(warehouseReceipts, and(eq(warehouseReceipts.transportId, transports.id), eq(warehouseReceipts.status, "stocked")))
    .where(and(eq(orders.stage, 6), where))
    .groupBy(orders.id);
}

/** 13.1: orders per stage, late orders (stage 1-2 past their delivery date), finished this month, average order time. */
export async function orderStatus(db: Database, f: Filters, today: string) {
  const where = orderFilter(f);
  const finished = finishedOrders(db, where).as("finished");
  const [stages, late, [done]] = await Promise.all([
    db
      .select({ stage: orders.stage, count: sql<number>`count(*)`.mapWith(Number) })
      .from(orders)
      .where(where)
      .groupBy(orders.stage),
    db
      .select({
        orderId: orders.id,
        po: orders.poNumber,
        supplier: suppliers.name,
        due: orders.deliveryDate,
        lateDays: sql<number>`${today}::date - ${orders.deliveryDate}`.mapWith(Number),
      })
      .from(orders)
      .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
      .where(and(where, lte(orders.stage, 2), lt(orders.deliveryDate, today)))
      .orderBy(asc(orders.deliveryDate), asc(orders.poNumber)),
    db
      .select({
        thisMonth: sql<number>`count(*) filter (where ${finished.finishedOn}::date >= ${`${today.slice(0, 8)}01`})`.mapWith(Number),
        averageOrderDays: sql<number | null>`round(avg(${finished.finishedOn}::date - ${finished.orderDate}))`.mapWith(Number),
      })
      .from(finished),
  ]);
  const stageCounts = [1, 2, 3, 4, 5, 6].map((stage) => stages.find((row) => row.stage === stage)?.count ?? 0);
  return { total: sum(stageCounts, (count) => count), stageCounts, late, finishedThisMonth: done?.thisMonth ?? 0, averageOrderDays: done?.averageOrderDays ?? null };
}

/** 13.2: orders at stage 1-2 due on each of the 14 days from today; late ones (due before today) are only counted. */
export async function deliveriesPerDay(db: Database, f: Filters, today: string) {
  const to = addDays(today, 13);
  const open = and(lte(orders.stage, 2), f.supplierId ? eq(orders.supplierId, f.supplierId) : undefined);
  const [perDay, [counts]] = await Promise.all([
    db
      .select({ date: orders.deliveryDate, count: sql<number>`count(*)`.mapWith(Number) })
      .from(orders)
      .where(and(open, gte(orders.deliveryDate, today), lte(orders.deliveryDate, to)))
      .groupBy(orders.deliveryDate),
    db
      .select({
        suppliersNext7: sql<number>`count(distinct ${orders.supplierId}) filter (where ${orders.deliveryDate} between ${today} and ${addDays(today, 6)})`.mapWith(Number),
        late: sql<number>`count(*) filter (where ${orders.deliveryDate} < ${today})`.mapWith(Number),
      })
      .from(orders)
      .where(open),
  ]);
  const byDay = new Map(perDay.map((row) => [row.date, row.count]));
  const days = Array.from({ length: 14 }, (_, index) => addDays(today, index)).map((date) => ({ date, count: byDay.get(date) ?? 0 }));
  const most = Math.max(...days.map((day) => day.count));
  return {
    from: today,
    to,
    days,
    dueNext7: sum(days.slice(0, 7), (day) => day.count),
    suppliersNext7: counts?.suppliersNext7 ?? 0,
    dueNext14: sum(days, (day) => day.count),
    busiest: most > 0 ? { dates: days.filter((day) => day.count === most).map((day) => day.date), count: most } : null,
    daysWithNone: days.filter((day) => day.count === 0).length,
    late: counts?.late ?? 0,
  };
}

/** 13.3: every line of every order with a receipt in China; short = ordered - received, valued at the line's rate. */
export async function orderedVsReceived(db: Database, f: Filters) {
  const rows = await db
    .select({
      orderLineId: orderLines.id,
      orderId: orders.id,
      po: orders.poNumber,
      supplier: suppliers.name,
      item: items.name,
      countedIn: items.countedIn,
      ordered: orderLines.quantity,
      rateCny: orderLines.rateCny,
      received: sql<number>`(select coalesce(sum(${receiptLines.quantity}), 0) from ${receiptLines} where ${receiptLines.orderLineId} = ${orderLines.id})`.mapWith(Number),
    })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
    .innerJoin(items, eq(items.id, orderLines.itemId))
    .where(and(orderFilter(f), sql`exists (select 1 from ${receipts} where ${receipts.orderId} = ${orders.id})`))
    .orderBy(desc(orders.orderDate), desc(orders.poNumber), asc(orderLines.position));
  const lines = rows.map(({ countedIn, rateCny, ...row }) => {
    const short = Math.max(0, row.ordered - row.received);
    return { ...row, unit: unit(countedIn), short, shortValueCny: short > 0 ? round2(short * rateCny) : null };
  });
  const checked = new Set(lines.map((line) => line.orderId));
  const shortPos = [...new Map(lines.filter((line) => line.short > 0).map((line) => [line.orderId, line.po])).values()];
  return {
    lines,
    ordersChecked: checked.size,
    shortPos,
    shortValueCny: round2(sum(lines, (line) => line.shortValueCny ?? 0)),
    fullOrders: checked.size - shortPos.length,
  };
}

/**
 * 13.4: containers whose loading-to-arrival span overlaps the window (`from`-`to`, default today - 25 to today + 24).
 * Arrival is the clearing's arrival date for an arrived container (else its ETA), and the ETA otherwise.
 */
export async function containersTimeline(db: Database, f: Filters, today: string) {
  const from = f.from ?? (f.to ? addDays(f.to, -49) : addDays(today, -25));
  const to = f.to ?? addDays(from, 49);
  const loaded = sql`coalesce(${containers.loadedOn}, ${containers.createdAt}::date)`;
  const arrival = sql`case when ${containers.status} = 'arrived' then coalesce(${clearings.arrivedOn}, ${containers.eta}) else ${containers.eta} end`;
  const ofSupplier = sql`exists (select 1 from ${containerLines}
    join ${orderLines} on ${orderLines.id} = ${containerLines.orderLineId}
    join ${orders} on ${orders.id} = ${orderLines.orderId}
    where ${containerLines.containerId} = ${containers.id} and ${orders.supplierId} = ${f.supplierId})`;
  const rows = await db
    .select({
      id: containers.id,
      number: containers.number,
      status: containers.status,
      loadedOn: sql<string>`(${loaded})::text`,
      arrival: sql<string>`(${arrival})::text`,
    })
    .from(containers)
    .leftJoin(clearings, eq(clearings.containerId, containers.id))
    .where(and(sql`${loaded} <= ${to}`, sql`${arrival} >= ${from}`, f.supplierId ? ofSupplier : undefined))
    .orderBy(asc(loaded), asc(containers.number));
  const arrived = rows.filter((row) => row.status === "arrived");
  const coming = rows.filter((row) => row.status !== "arrived" && row.arrival >= today).sort((a, b) => a.arrival.localeCompare(b.arrival) || a.number.localeCompare(b.number));
  return {
    from,
    to,
    containers: rows,
    active: rows.length - arrived.length,
    arrivingIn7Days: coming.filter((row) => row.arrival <= addDays(today, 7)).map((row) => row.arrival),
    averageSeaDays: arrived.length ? Math.round(sum(arrived, (row) => daysBetween(row.loadedOn, row.arrival)) / arrived.length) : null,
    nextArrival: coming[0] ? { date: coming[0].arrival, number: coming[0].number } : null,
  };
}

/**
 * 13.5: open orders (stage below 6) per supplier. Paid counts payments to the supplier only (agent payments are sea
 * freight, section 6.2); INR at each payment's own rate. `dueNext30Cny`: due supplier payments, today to today + 30.
 */
export async function paymentsPerSupplier(db: Database, f: Filters, today: string) {
  const where = orderFilter(f);
  const toSupplier = sql`${payments.orderId} = ${orders.id} and ${payments.payeeRole} = 'supplier'`;
  const newestFirst = [desc(orders.orderDate), desc(orders.poNumber)];
  const [open, finished] = await Promise.all([
    db
      .select({
        supplierId: suppliers.id,
        supplier: suppliers.name,
        po: orders.poNumber,
        orderValueCny: sql<number>`(select round(coalesce(sum(${orderLines.quantity} * ${orderLines.rateCny}), 0), 2) from ${orderLines}
          where ${orderLines.orderId} = ${orders.id})`.mapWith(Number),
        paidCny: sql<number>`(select coalesce(sum(${payments.amountCny}), 0) from ${payments} where ${toSupplier} and ${payments.status} = 'paid')`.mapWith(Number),
        paidInr: sql<number>`(select coalesce(sum(round(${payments.amountCny} * ${payments.rateInr}, 2)), 0) from ${payments}
          where ${toSupplier} and ${payments.status} = 'paid')`.mapWith(Number),
        dueNext30Cny: sql<number>`(select coalesce(sum(${payments.amountCny}), 0) from ${payments}
          where ${toSupplier} and ${payments.status} = 'due' and ${payments.dueDate} between ${today} and ${addDays(today, 30)})`.mapWith(Number),
      })
      .from(orders)
      .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
      .where(and(where, lt(orders.stage, 6)))
      .orderBy(...newestFirst),
    db
      .select({ po: orders.poNumber })
      .from(orders)
      .where(and(where, eq(orders.stage, 6)))
      .orderBy(...newestFirst),
  ]);
  // ponytail: grouped in memory over the open orders; a GROUP BY over pre-aggregated payments when orders reach thousands.
  const bySupplier = new Map<string, { supplierId: string; supplier: string; orders: string[]; orderValueCny: number; paidCny: number; paidInr: number }>();
  for (const order of open) {
    const row = bySupplier.get(order.supplierId) ?? { supplierId: order.supplierId, supplier: order.supplier, orders: [], orderValueCny: 0, paidCny: 0, paidInr: 0 };
    bySupplier.set(order.supplierId, { ...row, orders: [...row.orders, order.po], orderValueCny: row.orderValueCny + order.orderValueCny, paidCny: row.paidCny + order.paidCny, paidInr: row.paidInr + order.paidInr });
  }
  const rows = [...bySupplier.values()]
    .map((row) => ({ ...row, orderValueCny: round2(row.orderValueCny), paidCny: round2(row.paidCny), paidInr: round2(row.paidInr), balanceCny: round2(row.orderValueCny - row.paidCny) }))
    .sort((a, b) => b.orderValueCny - a.orderValueCny || a.supplier.localeCompare(b.supplier));
  const total = (pick: (row: (typeof rows)[number]) => number) => round2(sum(rows, pick));
  return {
    suppliers: rows,
    totals: { orders: open.length, orderValueCny: total((r) => r.orderValueCny), paidCny: total((r) => r.paidCny), paidInr: total((r) => r.paidInr), balanceCny: total((r) => r.balanceCny) },
    dueNext30Cny: round2(sum(open, (order) => order.dueNext30Cny)),
    finishedPos: finished.map((order) => order.po),
  };
}

const nextMonth = (month: string) => {
  const [year, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, "0")}`;
};

/**
 * 13.6: finished orders (landed cost final) by the month they reached the warehouse (their last stocked receipt).
 * The period keeps months, not order dates. Months run from `from` (else the first month with goods) to `to` (else this
 * month), with empty months as 0.
 */
export async function landedCostByMonth(db: Database, f: Filters, today: string) {
  const rows = (await finishedOrders(db, f.supplierId ? eq(orders.supplierId, f.supplierId) : undefined)).filter(
    (row) => (!f.from || row.finishedOn >= f.from) && (!f.to || row.finishedOn <= f.to),
  );
  const costs = await loadLandedCosts(
    db,
    rows.map((row) => row.id),
  );
  const done = rows.flatMap((row) => {
    const cost = costs.get(row.id);
    return cost?.final ? [{ month: row.finishedOn.slice(0, 7), pieces: cost.stockedPieces, landedCostInr: cost.totalInr }] : [];
  });
  const thisMonth = today.slice(0, 7);
  const first = f.from?.slice(0, 7) ?? done.map((row) => row.month).sort()[0];
  const last = f.to?.slice(0, 7) ?? thisMonth;
  const months: { month: string; pieces: number; landedCostInr: number; perPieceInr: number | null; soFar: boolean }[] = [];
  for (let month = first; month && month <= last; month = nextMonth(month)) {
    const inMonth = done.filter((row) => row.month === month);
    const pieces = sum(inMonth, (row) => row.pieces);
    const landedCostInr = round2(sum(inMonth, (row) => row.landedCostInr));
    months.push({ month, pieces, landedCostInr, perPieceInr: pieces > 0 ? round2(landedCostInr / pieces) : null, soFar: month === thisMonth });
  }
  const pieces = sum(done, (row) => row.pieces);
  const landedCostInr = round2(sum(done, (row) => row.landedCostInr));
  const biggest = months.reduce<(typeof months)[number] | null>((best, row) => (row.landedCostInr > (best?.landedCostInr ?? 0) ? row : best), null);
  return {
    months,
    totals: { orders: done.length, pieces, landedCostInr, perPieceInr: pieces > 0 ? round2(landedCostInr / pieces) : null },
    biggest: biggest ? { month: biggest.month, landedCostInr: biggest.landedCostInr } : null,
  };
}

/** The hub's stat strips (32), from the same reports and filters, plus the active suppliers for its filter. */
export async function summary(db: Database, f: Filters, today: string) {
  const [status, deliveries, received, timeline, paid, byMonth, supplierOptions] = await Promise.all([
    orderStatus(db, f, today),
    deliveriesPerDay(db, f, today),
    orderedVsReceived(db, f),
    containersTimeline(db, f, today),
    paymentsPerSupplier(db, f, today),
    landedCostByMonth(db, f, today),
    db
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .where(eq(suppliers.status, "Active"))
      .orderBy(asc(suppliers.createdAt), asc(suppliers.name)),
  ]);
  const short = (inUnit: string) => sum(received.lines, (line) => (line.unit === inUnit ? line.short : 0));
  return {
    suppliers: supplierOptions,
    orders: { total: status.total, atStage1: status.stageCounts[0] ?? 0 },
    deliveries: { dueNext7: deliveries.dueNext7, late: deliveries.late },
    receiving: { shortOrders: received.shortPos.length, shortPcs: short("pcs"), shortM: short("m") },
    containers: { onTheWay: timeline.active, arrivingIn7Days: timeline.arrivingIn7Days.length },
    payments: { dueNext30Cny: paid.dueNext30Cny },
    landedCost: { finishedOrders: byMonth.totals.orders, finishedTotalInr: byMonth.totals.landedCostInr },
  };
}

export const REPORTS = {
  summary,
  "order-status": orderStatus,
  "deliveries-per-day": deliveriesPerDay,
  "ordered-vs-received": orderedVsReceived,
  "containers-timeline": containersTimeline,
  "payments-per-supplier": paymentsPerSupplier,
  "landed-cost-by-month": landedCostByMonth,
} satisfies Record<string, (db: Database, f: Filters, today: string) => Promise<object>>;
