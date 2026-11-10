import { and, count, eq, gte, lte, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "../../db/client";
import { containerLines, containers, type Currency, CURRENCIES, orderLines, orders, payments, receipts, suppliers } from "../../db/schema";
import { orderClosed } from "../orders/closure";
import { round2, supplierMoney } from "../orders/money";
import { addDays } from "../reports/reports";
import { creationOrder } from "./list-query";

// The Suppliers page (docs/suppliers.md): the list rows' money (MD-1), the KPI summary (SUP-1) and the performance and
// analytics figures (SUP-2). Money is the supplier-only money of money.ts, kept per order currency and never added
// across currencies. Delivery is measured in China: an order is delivered on the day of its first receipt (REC-3).

export type MoneyTotal = { currency: Currency; amount: number };
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const sum = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null);
const average = (values: number[]) => (values.length ? Math.round(sum(values, (value) => value) / values.length) : null);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const distinct = <T>(values: T[]) => [...new Set(values)];

/** One total per currency present (CNY, USD, INR order); amounts in different currencies are never added together. */
export function byCurrency<T extends { currency: Currency }>(rows: T[], pick: (row: T) => number): MoneyTotal[] {
  return CURRENCIES.filter((currency) => rows.some((row) => row.currency === currency)).map((currency) => ({
    currency,
    amount: round2(sum(rows.filter((row) => row.currency === currency), pick)),
  }));
}

/** The next code the API assigns, SUP-001 style, under a transaction lock so two creates never draw the same number. */
export async function nextCode(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('suppliers.code'))`);
  const [row] = await tx
    .select({ next: sql<number>`coalesce(max(substring(${suppliers.code} from '^SUP-([0-9]{1,9})$')::int), 0) + 1`.mapWith(Number) })
    .from(suppliers);
  return `SUP-${String(row?.next ?? 1).padStart(3, "0")}`;
}

/** Every order in scope with its supplier money and the day China first received it (null until then). */
function orderRows(db: Database, where?: SQL) {
  return db
    .select({
      id: orders.id,
      supplierId: orders.supplierId,
      currency: orders.currency,
      orderDate: orders.orderDate,
      deliveryDate: orders.deliveryDate,
      stage: orders.stage,
      closed: orderClosed,
      orderValueCny: supplierMoney.orderValueCny,
      paidCny: supplierMoney.paidCny,
      receivedOn: sql<string | null>`(select min(${receipts.receivedOn})::text from ${receipts} where ${receipts.orderId} = ${orders.id})`,
    })
    .from(orders)
    .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
    .where(where);
}
type OrderRow = Awaited<ReturnType<typeof orderRows>>[number];

const balanceOf = (row: OrderRow) => row.orderValueCny - row.paidCny;

// ponytail: every order is loaded and grouped in memory (a few hundred rows); a GROUP BY over money.ts when orders reach thousands.
/** Per supplier: this year's order value (orders dated from 1 January) and the balance still owed, per currency. */
export async function supplierMoneyRows(db: Database, today: string) {
  const rows = await orderRows(db);
  const jan1 = `${today.slice(0, 4)}-01-01`;
  return new Map(
    distinct(rows.map((row) => row.supplierId)).map((supplierId) => {
      const own = rows.filter((row) => row.supplierId === supplierId);
      return [
        supplierId,
        { ytdValue: byCurrency(own.filter((row) => row.orderDate >= jan1), (row) => row.orderValueCny), balance: byCurrency(own, balanceOf) },
      ];
    }),
  );
}

/** SUP-1: the five KPI cards. Open = not closed (phase 2 §1); in transit = stages 3-5 (left China, not yet stocked). */
export async function suppliersSummary(db: Database, today: string) {
  const [[counts], rows, [transit], due] = await Promise.all([
    db.select({ total: count(), active: sql<number>`count(*) filter (where ${suppliers.status} = 'Active')`.mapWith(Number) }).from(suppliers),
    orderRows(db),
    db
      .select({
        nextEta: sql<string | null>`(min(${containers.eta}) filter (where ${containers.eta} >= ${today}))::text`,
        arrivingNext7: sql<number>`count(distinct ${containers.id}) filter (where ${containers.eta} between ${today} and ${addDays(today, 6)})`.mapWith(Number),
      })
      .from(containers)
      .innerJoin(containerLines, eq(containerLines.containerId, containers.id))
      .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
      .where(and(sql`${containers.status} <> 'arrived'`, sql`${orders.stage} between 3 and 5`)),
    db
      .select({ currency: orders.currency, count: count(), amount: sql<number>`coalesce(sum(${payments.amountCny}), 0)`.mapWith(Number) })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(and(eq(payments.payeeRole, "supplier"), eq(payments.status, "due"), gte(payments.dueDate, today), lte(payments.dueDate, addDays(today, 6))))
      .groupBy(orders.currency),
  ]);
  const open = rows.filter((row) => !row.closed);
  // A supplier owes nothing in a currency it has overpaid: only positive balances count as unpaid.
  const owed = distinct(rows.map((row) => row.supplierId)).flatMap((supplierId) =>
    byCurrency(rows.filter((row) => row.supplierId === supplierId), balanceOf)
      .filter((total) => total.amount > 0)
      .map((total) => ({ ...total, supplierId })),
  );
  const total = counts?.total ?? 0;
  const active = counts?.active ?? 0;
  return {
    suppliers: { total, active, inactive: total - active },
    openPos: { count: open.length, value: byCurrency(open, (row) => row.orderValueCny) },
    inTransit: { orders: rows.filter((row) => row.stage >= 3 && row.stage <= 5).length, nextEta: transit?.nextEta ?? null, arrivingNext7: transit?.arrivingNext7 ?? 0 },
    unpaid: { amount: byCurrency(owed, (total) => total.amount), suppliers: distinct(owed.map((total) => total.supplierId)).length },
    upcomingPayments: { windowDays: 7, count: sum(due, (row) => row.count), amount: byCurrency(due, (row) => row.amount) },
  };
}

export const insightsQuery = z
  .strictObject({ from: z.iso.date().optional(), to: z.iso.date().optional(), supplierId: z.uuid().optional() })
  .refine((query) => !query.from || !query.to || query.from <= query.to);
export type InsightsQuery = z.infer<typeof insightsQuery>;

/** Order, delivery and completion figures of a set of orders. */
function stats(list: OrderRow[], today: string) {
  const delivered = list.filter((row) => row.receivedOn !== null);
  const onTime = delivered.filter((row) => row.receivedOn! <= row.deliveryDate).length;
  // Not delivered, past its delivery date and still waiting on the supplier (stage 1-2): late, as the Order status report counts it.
  const overdue = list.filter((row) => row.receivedOn === null && row.stage <= 2 && row.deliveryDate < today).length;
  const completed = list.filter((row) => row.closed).length;
  return {
    orders: list.length,
    completed,
    completionRate: pct(completed, list.length),
    delivered: delivered.length,
    onTime,
    onTimeRate: pct(onTime, delivered.length),
    delayed: delivered.length - onTime + overdue,
    averageDeliveryDays: average(delivered.map((row) => daysBetween(row.orderDate, row.receivedOn!))),
  };
}

const shiftMonth = (month: string, by: number) => {
  const [year, m] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + (m - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
};
const amountIn = (totals: MoneyTotal[], currency: Currency) => totals.find((total) => total.currency === currency)?.amount ?? 0;
/** Biggest first, currency by currency (CNY, then USD, then INR), then by name. */
const byValue = <T extends { name: string; value: MoneyTotal[] }>(a: T, b: T) =>
  CURRENCIES.reduce((order, currency) => order || amountIn(b.value, currency) - amountIn(a.value, currency), 0) || a.name.localeCompare(b.name);

/**
 * SUP-2: the Supplier Performance and Analytics tabs for the orders placed in `from`-`to` (order date) with the
 * supplier. Months run from `from` (else 11 months before this one) to `to` (else today); payment trends count supplier
 * payments by the day they were paid, in that window.
 */
export async function supplierInsights(db: Database, q: InsightsQuery, today: string) {
  const lastMonth = (q.to ?? today).slice(0, 7);
  const firstMonth = (q.from ?? `${shiftMonth(lastMonth, -11)}-01`).slice(0, 7);
  const scope = and(
    q.from ? gte(orders.orderDate, q.from) : undefined,
    q.to ? lte(orders.orderDate, q.to) : undefined,
    q.supplierId ? eq(orders.supplierId, q.supplierId) : undefined,
  );
  const paidMonth = sql<string>`to_char(${payments.paidOn}, 'YYYY-MM')`;
  const [rows, supplierRows, paid] = await Promise.all([
    orderRows(db, scope),
    db
      .select({ id: suppliers.id, code: suppliers.code, name: suppliers.name, country: suppliers.country, status: suppliers.status })
      .from(suppliers)
      .orderBy(...creationOrder(suppliers)),
    db
      .select({
        month: paidMonth,
        currency: orders.currency,
        amountCny: sql<number>`coalesce(sum(${payments.amountCny}), 0)`.mapWith(Number),
        amountInr: sql<number>`coalesce(sum(round(${payments.amountCny} * ${payments.rateInr}, 2)), 0)`.mapWith(Number),
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(
        and(
          eq(payments.payeeRole, "supplier"),
          eq(payments.status, "paid"),
          gte(payments.paidOn, q.from ?? `${firstMonth}-01`),
          lte(payments.paidOn, q.to ?? today),
          q.supplierId ? eq(orders.supplierId, q.supplierId) : undefined,
        ),
      )
      .groupBy(paidMonth, orders.currency),
  ]);

  const byId = new Map(supplierRows.map((supplier) => [supplier.id, supplier]));
  const bySupplier = distinct(rows.map((row) => row.supplierId))
    .map((supplierId) => {
      const own = rows.filter((row) => row.supplierId === supplierId);
      const supplier = byId.get(supplierId)!;
      return {
        supplierId,
        code: supplier.code,
        name: supplier.name,
        country: supplier.country,
        ...stats(own, today),
        value: byCurrency(own, (row) => row.orderValueCny),
        balance: byCurrency(own, balanceOf),
      };
    })
    .sort(byValue);
  // Top performers: the best on-time rate among suppliers that have delivered, then the most completed and placed orders.
  const top = bySupplier
    .filter((supplier) => supplier.delivered > 0)
    .sort((a, b) => (b.onTimeRate ?? 0) - (a.onTimeRate ?? 0) || b.completed - a.completed || b.orders - a.orders || a.name.localeCompare(b.name))
    .slice(0, 5);
  const months: string[] = [];
  for (let month = firstMonth; month <= lastMonth; month = shiftMonth(month, 1)) months.push(month);
  const byCountry = distinct(supplierRows.map((supplier) => supplier.country))
    .map((country) => ({ country, suppliers: supplierRows.filter((supplier) => supplier.country === country).length }))
    .sort((a, b) => b.suppliers - a.suppliers || a.country.localeCompare(b.country));

  return {
    filter: { from: q.from ?? null, to: q.to ?? null, supplier: q.supplierId ? (byId.get(q.supplierId)?.name ?? null) : null },
    suppliers: { total: supplierRows.length, active: supplierRows.filter((supplier) => supplier.status === "Active").length },
    summary: stats(rows, today),
    bySupplier,
    top,
    byCountry,
    monthly: months.map((month) => {
      const inMonth = paid.filter((row) => row.month === month);
      return {
        month,
        value: byCurrency(rows.filter((row) => row.orderDate.slice(0, 7) === month), (row) => row.orderValueCny),
        paid: byCurrency(inMonth, (row) => row.amountCny),
        paidInr: round2(sum(inMonth, (row) => row.amountInr)),
      };
    }),
  };
}
