import { and, asc, count, eq, ilike, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "../../db/client";
import { CURRENCIES, items, locations, orderLines, orders, suppliers, warehouseReceiptLines, warehouseReceipts } from "../../db/schema";
import { loadLandedCosts } from "../costs/landed-cost";
import { main, newestFirst, orderColumns, PO_MAX_LENGTH, round2, unitSymbol } from "../orders/orders.routes";
import { orderFilter, supplierMoney } from "./reports";

// Owner: Agent R. RPT-O2 GET /reports/orders (docs/phase2-contracts.md section 4.2; shape in 8.R; the comprehensive
// report's additions in docs/order-report.md): every order with its payments, closure and landed cost, filtered. The
// ORD-1 figures, with paid and balance counting supplier payments only (13.5 `supplierMoney`; agent payments are sea
// freight), so value - paid = balance on every row.

export const ORDER_STATES = ["pending", "active", "closed"] as const;
export const PAYMENT_STATES = ["unpaid", "partly", "paid"] as const;

export const orderReportsQuery = z
  .strictObject({
    po: z.string().trim().max(PO_MAX_LENGTH).optional(),
    /** A case-insensitive part of the supplier's name. */
    supplier: z.string().trim().max(200).optional(),
    supplierId: z.uuid().optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    status: z.enum(ORDER_STATES).optional(),
    /** The order's stage (1-6): the shipment status filter (3 in a container, 4 clearing, 5 on the road, 6 in the warehouse). */
    stage: z
      .string()
      .regex(/^[1-6]$/)
      .transform(Number)
      .optional(),
    currency: z.enum(CURRENCIES).optional(),
    warehouseId: z.uuid().optional(),
    paymentStatus: z.enum(PAYMENT_STATES).optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to);
type Query = z.infer<typeof orderReportsQuery>;

/** Pending: not yet received (stage 1); closed: section 1's rule (ORD-1 `closed`); active: the rest. */
const stateOf = (row: { stage: number; closed: boolean }) => (row.stage === 1 ? "pending" : row.closed ? "closed" : "active");
/** Supplier payments against the order value: nothing paid, part of it, or all of it (an overpayment counts as paid). */
const paymentStateOf = (row: { paidCny: number; orderValueCny: number }) => (row.paidCny <= 0 ? "unpaid" : row.paidCny >= row.orderValueCny ? "paid" : "partly");
const sum = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);
/** `%`, `_` and `\` typed in the PO filter match themselves (LIKE's default escape is `\`). */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

/** The filtered orders, their summary, the filter echo (names) and the page's select options. Six queries, plus loadLandedCosts. */
export async function orderReports(db: Database, q: Query) {
  const po = q.po || undefined;
  const supplierText = q.supplier || undefined;
  // Orders with some of their own goods on a stocked receipt at that warehouse.
  const stockedAt = sql`exists (select 1 from ${warehouseReceiptLines}
    join ${warehouseReceipts} on ${warehouseReceipts.id} = ${warehouseReceiptLines.receiptId} and ${warehouseReceipts.status} = 'stocked'
    join ${orderLines} on ${orderLines.id} = ${warehouseReceiptLines.orderLineId}
    where ${orderLines.orderId} = ${orders.id} and ${warehouseReceipts.locationId} = ${q.warehouseId})`;
  const nameOf = (table: typeof suppliers | typeof locations, id?: string) => (id ? db.select({ name: table.name }).from(table).where(eq(table.id, id)) : []);

  const [rows, supplierOptions, warehouseOptions, supplier, warehouse] = await Promise.all([
    db
      .select({ ...orderColumns, supplierCode: suppliers.code, paidCny: supplierMoney.paidCny, paidInr: supplierMoney.paidInr })
      .from(orders)
      .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
      .innerJoin(main, and(eq(main.orderId, orders.id), eq(main.position, 0)))
      .innerJoin(items, eq(items.id, main.itemId))
      .where(
        and(
          orderFilter(q),
          po ? ilike(orders.poNumber, `%${escapeLike(po)}%`) : undefined,
          supplierText ? ilike(suppliers.name, `%${escapeLike(supplierText)}%`) : undefined,
          q.stage ? eq(orders.stage, q.stage) : undefined,
          q.currency ? eq(orders.currency, q.currency) : undefined,
          q.warehouseId ? stockedAt : undefined,
        ),
      )
      .orderBy(...newestFirst),
    db
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .where(eq(suppliers.status, "Active"))
      .orderBy(asc(suppliers.createdAt), asc(suppliers.name)),
    db
      .select({ id: locations.id, name: locations.name })
      .from(locations)
      .where(and(eq(locations.type, "Warehouse"), eq(locations.status, "Active")))
      .orderBy(asc(locations.createdAt), asc(locations.name)),
    nameOf(suppliers, q.supplierId),
    nameOf(locations, q.warehouseId),
  ]);
  // Status and payment status come from the row's own figures, so they are applied here rather than repeated in SQL.
  const kept = rows.filter((row) => (!q.status || stateOf(row) === q.status) && (!q.paymentStatus || paymentStateOf(row) === q.paymentStatus));
  const ids = kept.map((row) => row.id);
  const [costs, lineTotals] = await Promise.all([
    loadLandedCosts(db, ids),
    // Every line of the kept orders, per unit: how many items and how much was ordered (never added across units).
    ids.length
      ? db
          .select({ orderId: orderLines.orderId, unit: unitSymbol, lines: count(), quantity: sql<number>`sum(${orderLines.quantity})`.mapWith(Number) })
          .from(orderLines)
          .innerJoin(items, eq(items.id, orderLines.itemId))
          .where(inArray(orderLines.orderId, ids))
          .groupBy(orderLines.orderId, unitSymbol)
      : [],
  ]);
  const list = kept.map((row) => {
    const cost = costs.get(row.id)!;
    const units = lineTotals.filter((total) => total.orderId === row.id).sort((a, b) => (a.unit === "pcs" ? -1 : b.unit === "pcs" ? 1 : a.unit.localeCompare(b.unit)));
    return {
      id: row.id,
      po: row.po,
      orderDate: row.orderDate,
      deliveryDate: row.deliveryDate,
      stage: row.stage,
      supplier: { id: row.supplierId, name: row.supplierName, code: row.supplierCode },
      currency: row.currency,
      item: row.item,
      quantity: row.quantity,
      unit: row.unit,
      received: row.received,
      stocked: row.stocked,
      /** Distinct lines on the order, and the ordered quantity per unit over every line. */
      lineCount: sum(units, (total) => total.lines),
      quantities: units.map((total) => ({ unit: total.unit, quantity: total.quantity })),
      closed: row.closed,
      closedOn: row.closedOn,
      orderValueCny: row.orderValueCny,
      paidCny: row.paidCny,
      paidInr: row.paidInr,
      balanceCny: round2(row.orderValueCny - row.paidCny),
      paymentStatus: paymentStateOf(row),
      /** null until the order has any cost (as the Landed Cost list hides costless orders). */
      landedCostInr: cost.totalInr > 0 ? cost.totalInr : null,
      perPieceInr: cost.totalInr > 0 ? cost.perPieceInr : null,
    };
  });
  return {
    rows: list,
    summary: {
      orders: list.length,
      byCurrency: CURRENCIES.filter((currency) => list.some((row) => row.currency === currency)).map((currency) => {
        const inCurrency = list.filter((row) => row.currency === currency);
        return {
          currency,
          orderValueCny: round2(sum(inCurrency, (row) => row.orderValueCny)),
          paidCny: round2(sum(inCurrency, (row) => row.paidCny)),
          balanceCny: round2(sum(inCurrency, (row) => row.balanceCny)),
        };
      }),
      paidInr: round2(sum(list, (row) => row.paidInr)),
      landedCostInr: round2(sum(list, (row) => row.landedCostInr ?? 0)),
    },
    filter: {
      po: po ?? null,
      supplierName: supplierText ?? null,
      supplier: supplier[0]?.name ?? null,
      from: q.from ?? null,
      to: q.to ?? null,
      status: q.status ?? null,
      stage: q.stage ?? null,
      currency: q.currency ?? null,
      warehouse: warehouse[0]?.name ?? null,
      paymentStatus: q.paymentStatus ?? null,
    },
    options: { suppliers: supplierOptions, warehouses: warehouseOptions },
  };
}
