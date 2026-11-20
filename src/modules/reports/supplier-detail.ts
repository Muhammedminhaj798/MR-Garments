import { and, asc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import { orderedCurrencies } from "../../currencies";
import type { Database } from "../../db/client";
import { type Currency, items, orderLines, orders, payments, suppliers } from "../../db/schema";
import { notFound } from "../../http/errors";
import { accountsView, cents, fromCents, loadLedger, newestPaymentsFirst, paymentQuery, paymentRow, settlementFields } from "../ledger/ledger";
import { supplierStatement } from "../ledger/ledger.routes";
import { orderClosed } from "../orders/closure";
import { orderMoney } from "../orders/money";
import { main, newestFirst, orderColumns, unitSymbol } from "../orders/orders.routes";
import { orderFilter } from "./reports";

// GET /reports/payments-per-supplier/:supplierId (docs/supplier-payment-detail-contract.md; money per
// docs/unified-ledger.md RPT-5D): one supplier's orders (with the ledger's FIFO projection), its payments (orderless
// ones included, voided flagged) and order lines, each list paged by 10, with its ledger accounts and statement.

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
const pageOf = <T>(rows: T[], total: number, page: number) => ({ rows, total, page, pageSize: PAGE_SIZE });
// ponytail: `all` lists at most this many rows per list; page the download if one supplier ever has more.
const ALL_ROWS = 100_000;

/** The supplier's detail, or 404 for a malformed or unknown id. Nine queries, none per row. */
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
  // The supplier's payments: order-linked ones of its orders in the period, and its orderless ones (no order date).
  const ofSupplier = and(
    eq(payments.payeeRole, "supplier"),
    or(and(isNull(payments.orderId), eq(payments.supplierId, supplierId)), and(scope, sql`${payments.orderId} is not null`)),
  );
  const quantityIn = (metres: boolean) =>
    sql<number | null>`(select sum(${orderLines.quantity}) from ${orderLines} join ${items} on ${items.id} = ${orderLines.itemId}
      where ${orderLines.orderId} = ${orders.id} and (${items.countedIn} = 'Metres') = ${metres})`.mapWith(Number);

  const [perOrder, [paymentCounts], [lineCounts], paymentList, orderRows, lineRows, ledger, entries] = await Promise.all([
    // Per order: its value, stage and whether it is closed, grouped by order currency below. The join keeps the
    // closure fragment's columns qualified (closure.ts).
    db
      .select({ id: orders.id, currency: orders.currency, stage: orders.stage, closed: orderClosed, orderValueCny: orderMoney.orderValueCny })
      .from(orders)
      .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
      .where(scope),
    db
      .select({ all: count, listed: sql<number>`count(*) filter (where ${inPaymentRange})`.mapWith(Number) })
      .from(payments)
      .leftJoin(orders, eq(orders.id, payments.orderId))
      .where(ofSupplier),
    db
      .select({ all: count, products: sql<number>`count(distinct ${orderLines.itemId})`.mapWith(Number) })
      .from(orderLines)
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
      .where(scope),
    // PAY-1's order; the id last keeps pages stable when payments share a timestamp (one insert).
    paymentQuery(db, and(ofSupplier, inPaymentRange))
      .orderBy(...newestPaymentsFirst)
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
        orderValueCny: orderMoney.orderValueCny,
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
    loadLedger(db, { supplierIds: [supplierId] }),
    supplierStatement(db, supplierId),
  ]);

  // Per currency of its orders in the period (and, without a period, of its accounts): the orders' value, settled and
  // outstanding (FIFO projection), and the account's credits, signed balance and payments' INR (whole, never dated).
  const accounts = accountsView(ledger, supplierId);
  const accountCurrencies = q.from || q.to ? [] : accounts.map((account) => account.currency as Currency);
  const currencies = orderedCurrencies<Currency>([...perOrder.map((row) => row.currency), ...accountCurrencies]).map((currency) => {
    const own = perOrder.filter((row) => row.currency === currency);
    const account = accounts.find((row) => row.currency === currency);
    const held = account?.held ?? false;
    const sumOf = (pick: (row: (typeof own)[number]) => number | null | undefined) => fromCents(own.reduce((total, row) => total + cents(pick(row) ?? 0), 0));
    return {
      currency,
      held,
      orders: own.length,
      openOrders: own.filter((row) => !row.closed).length,
      listed: own.filter((row) => !q.stage || row.stage === q.stage).length,
      orderValueCny: sumOf((row) => row.orderValueCny),
      settledCny: held ? null : sumOf((row) => ledger.order(row.id)?.settledCny),
      outstandingCny: held ? null : sumOf((row) => ledger.order(row.id)?.outstandingCny),
      creditsCny: held ? null : (account?.creditsCny ?? 0),
      balanceCny: held ? null : (account?.balanceCny ?? 0),
      paidInr: held ? null : (account?.paidInr ?? 0),
    };
  });
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
      byCurrency: currencies.map(({ openOrders: _open, listed: _listed, ...row }) => row),
    },
    // The supplier's ledger, whole: it is not dated by the orders' range.
    ledger: { accounts, entries },
    payments: pageOf(paymentList.map(paymentRow), paymentCounts?.listed ?? 0, pages.payments),
    orders: pageOf(
      orderRows.map(({ pcs, metres, ...row }) => ({
        ...row,
        quantities: [
          ...(pcs === null ? [] : [{ unit: "pcs" as const, quantity: pcs }]),
          ...(metres === null ? [] : [{ unit: "m" as const, quantity: metres }]),
        ],
        ...settlementFields(ledger.order(row.id)),
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
