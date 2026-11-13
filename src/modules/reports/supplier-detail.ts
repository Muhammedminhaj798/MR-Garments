import { and, asc, desc, eq, gte, lte, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { compareCurrencies } from "../../currencies";
import type { Database } from "../../db/client";
import { items, orderLines, orders, payments, suppliers } from "../../db/schema";
import { notFound } from "../../http/errors";
import { orderClosed } from "../orders/closure";
import { main, newestFirst, orderColumns, round2, unitSymbol } from "../orders/orders.routes";
import { orderFilter, supplierMoney, toSupplier } from "./reports";

// GET /reports/payments-per-supplier/:supplierId (docs/supplier-payment-detail-contract.md): one supplier's orders,
// supplier payments and order lines with the report's money rules (13.5), each list paged by 10.

const PAGE_SIZE = 10;
const date = z.iso.date().optional();
// Up to 15 digits, so the offset stays a whole number PostgreSQL takes; "0", "1.5", "abc" and "" are 400.
const page = z.string().regex(/^[1-9]\d{0,14}$/).transform(Number).optional();

export const detailQuery = z
  .strictObject({
    from: date,
    to: date,
    paymentFrom: date,
    paymentTo: date,
    stage: z.string().regex(/^[1-6]$/).transform(Number).optional(),
    paymentsPage: page,
    ordersPage: page,
    linesPage: page,
    // The report download (docs/report-downloads.md): every row of each list in one answer, the pages ignored.
    all: z.literal("1").optional(),
  })
  .refine((q) => (!q.from || !q.to || q.from <= q.to) && (!q.paymentFrom || !q.paymentTo || q.paymentFrom <= q.paymentTo));
type DetailQuery = z.infer<typeof detailQuery>;

const count = sql<number>`count(*)`.mapWith(Number);
const sumOf = (column: SQL.Aliased<number>) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
const pageOf = <T>(rows: T[], total: number, page: number) => ({ rows, total, page, pageSize: PAGE_SIZE });
// ponytail: `all` lists at most this many rows per list; page the download if one supplier ever has more.
const ALL_ROWS = 100_000;

/** The supplier's detail, or 404 for a malformed or unknown id. Seven queries, none per row. */
export async function supplierPaymentDetail(db: Database, supplierId: string, q: DetailQuery) {
  if (!z.uuid().safeParse(supplierId).success) throw notFound("Supplier");
  const [supplier] = await db
    .select({
      id: suppliers.id,
      code: suppliers.code,
      name: suppliers.name,
      contactPerson: suppliers.contactPerson,
      phone: suppliers.phone,
      email: suppliers.email,
      country: suppliers.country,
      city: suppliers.city,
      state: suppliers.state,
      postalCode: suppliers.postalCode,
      address: suppliers.address,
      paymentTerms: suppliers.paymentTerms,
      taxNumber: suppliers.taxNumber,
      notes: suppliers.notes,
      currency: suppliers.currency,
      /** INR per 1 unit of `currency` now (docs/supplier-currency.md), null while not set, and when it was last set. */
      exchangeRate: suppliers.exchangeRate,
      rateUpdatedAt: suppliers.rateUpdatedAt,
      status: suppliers.status,
    })
    .from(suppliers)
    .where(eq(suppliers.id, supplierId));
  if (!supplier) throw notFound("Supplier");

  const scope = orderFilter({ supplierId, from: q.from, to: q.to });
  const pages = { payments: q.paymentsPage ?? 1, orders: q.ordersPage ?? 1, lines: q.linesPage ?? 1 };
  const offset = (n: number) => (q.all ? 0 : (n - 1) * PAGE_SIZE);
  const limit = q.all ? ALL_ROWS : PAGE_SIZE;
  const paymentDay = sql`coalesce(${payments.paidOn}, ${payments.dueDate})`;
  const inPaymentRange = and(q.paymentFrom ? gte(paymentDay, q.paymentFrom) : undefined, q.paymentTo ? lte(paymentDay, q.paymentTo) : undefined) ?? sql`true`;
  const ofSupplier = and(scope, eq(payments.payeeRole, "supplier"));

  // Per order: the report's money, deposits (a subset of paid), the stage and whether it is closed, grouped by order
  // currency below. The join keeps the closure fragment's columns qualified (closure.ts).
  const perOrder = db
    .select({
      currency: orders.currency,
      stage: orders.stage,
      closed: orderClosed.as("closed"),
      orderValueCny: supplierMoney.orderValueCny.as("order_value_cny"),
      paidCny: supplierMoney.paidCny.as("paid_cny"),
      paidInr: supplierMoney.paidInr.as("paid_inr"),
      depositsCny: sql<number>`(select coalesce(sum(${payments.amountCny}), 0) from ${payments}
        where ${toSupplier} and ${payments.status} = 'paid' and ${payments.kind} = 'Deposit')`.as("deposits_cny"),
    })
    .from(orders)
    .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
    .where(scope)
    .as("per_order");
  const quantityIn = (metres: boolean) =>
    sql<number | null>`(select sum(${orderLines.quantity}) from ${orderLines} join ${items} on ${items.id} = ${orderLines.itemId}
      where ${orderLines.orderId} = ${orders.id} and (${items.countedIn} = 'Metres') = ${metres})`.mapWith(Number);

  const [currencies, [paymentCounts], [lineCounts], paymentRows, orderRows, lineRows] = await Promise.all([
    db
      .select({
        currency: perOrder.currency,
        orders: count,
        // Open = not closed (docs/phase2-contracts.md 1), as Payments per supplier counts them.
        openOrders: sql<number>`count(*) filter (where not ${perOrder.closed})`.mapWith(Number),
        listed: sql<number>`count(*) filter (where ${q.stage ? sql`${perOrder.stage} = ${q.stage}` : sql`true`})`.mapWith(Number),
        orderValueCny: sumOf(perOrder.orderValueCny),
        paidCny: sumOf(perOrder.paidCny),
        paidInr: sumOf(perOrder.paidInr),
        depositsCny: sumOf(perOrder.depositsCny),
        balanceCny: sql<number>`coalesce(sum(${perOrder.orderValueCny}) - sum(${perOrder.paidCny}), 0)`.mapWith(Number),
      })
      .from(perOrder)
      .groupBy(perOrder.currency),
    db
      .select({ all: count, listed: sql<number>`count(*) filter (where ${inPaymentRange})`.mapWith(Number) })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(ofSupplier),
    db
      .select({ all: count, products: sql<number>`count(distinct ${orderLines.itemId})`.mapWith(Number) })
      .from(orderLines)
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
      .where(scope),
    db
      .select({
        id: payments.id,
        orderId: payments.orderId,
        po: orders.poNumber,
        currency: orders.currency,
        kind: payments.kind,
        status: payments.status,
        paidOn: payments.paidOn,
        dueDate: payments.dueDate,
        amountCny: payments.amountCny,
        rateInr: payments.rateInr,
        amountInr: sql<number | null>`case when ${payments.status} = 'paid' then round(${payments.amountCny} * ${payments.rateInr}, 2) end`.mapWith(Number),
        mode: payments.mode,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(and(ofSupplier, inPaymentRange))
      // PAY-1's order; the id last keeps pages stable when payments share a timestamp (one insert).
      .orderBy(desc(paymentDay), desc(payments.createdAt), desc(payments.id))
      .limit(limit)
      .offset(offset(pages.payments)),
    db
      .select({
        id: orders.id,
        po: orders.poNumber,
        orderDate: orders.orderDate,
        deliveryDate: orders.deliveryDate,
        stage: orders.stage,
        currency: orders.currency,
        pcs: quantityIn(false),
        metres: quantityIn(true),
        quantity: orderColumns.quantity,
        received: orderColumns.received,
        unit: orderColumns.unit,
        orderValueCny: supplierMoney.orderValueCny,
        paidCny: supplierMoney.paidCny,
      })
      .from(orders)
      .innerJoin(main, and(eq(main.orderId, orders.id), eq(main.position, 0)))
      .innerJoin(items, eq(items.id, main.itemId))
      .where(and(scope, q.stage ? eq(orders.stage, q.stage) : undefined))
      .orderBy(...newestFirst)
      .limit(limit)
      .offset(offset(pages.orders)),
    db
      .select({
        orderLineId: orderLines.id,
        orderId: orders.id,
        po: orders.poNumber,
        itemId: items.id,
        item: items.name,
        unit: unitSymbol,
        quantity: orderLines.quantity,
        rateCny: orderLines.rateCny,
        amountCny: sql<number>`round(${orderLines.quantity} * ${orderLines.rateCny}, 2)`.mapWith(Number),
        currency: orders.currency,
      })
      .from(orderLines)
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
      .innerJoin(items, eq(items.id, orderLines.itemId))
      .where(scope)
      .orderBy(...newestFirst, asc(orderLines.position))
      .limit(limit)
      .offset(offset(pages.lines)),
  ]);

  const total = (pick: (row: (typeof currencies)[number]) => number) => currencies.reduce((sum, row) => sum + pick(row), 0);
  return {
    supplier,
    filter: { from: q.from ?? null, to: q.to ?? null },
    summary: {
      orders: total((row) => row.orders),
      openOrders: total((row) => row.openOrders),
      payments: paymentCounts?.all ?? 0,
      lineItems: lineCounts?.all ?? 0,
      products: lineCounts?.products ?? 0,
      byCurrency: currencies
        .sort((a, b) => compareCurrencies(a.currency, b.currency))
        .map((row) => ({
          currency: row.currency,
          orders: row.orders,
          orderValueCny: row.orderValueCny,
          paidCny: row.paidCny,
          paidInr: row.paidInr,
          depositsCny: row.depositsCny,
          balanceCny: row.balanceCny,
        })),
    },
    payments: pageOf(paymentRows, paymentCounts?.listed ?? 0, pages.payments),
    orders: pageOf(
      orderRows.map(({ pcs, metres, ...row }) => ({
        ...row,
        quantities: [
          ...(pcs === null ? [] : [{ unit: "pcs" as const, quantity: pcs }]),
          ...(metres === null ? [] : [{ unit: "m" as const, quantity: metres }]),
        ],
        balanceCny: round2(row.orderValueCny - row.paidCny),
      })),
      total((row) => row.listed),
      pages.orders,
    ),
    lines: pageOf(
      lineRows,
      lineCounts?.all ?? 0,
      pages.lines,
    ),
  };
}
