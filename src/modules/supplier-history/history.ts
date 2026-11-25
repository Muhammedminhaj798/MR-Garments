import { and, asc, desc, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { compareCurrencies } from "../../currencies";
import type { Database } from "../../db/client";
import {
  clearings,
  containerLines,
  containers,
  finalCostProtections,
  items,
  locations,
  orderLines,
  orders,
  payments,
  receiptLines,
  receipts,
  supplierAdvanceEntries as advances,
  supplierLedgerEntries as entries,
  supplierLedgerHolds as holds,
  suppliers,
  teams,
  transports,
  users,
  warehouseReceiptLines,
  warehouseReceipts,
} from "../../db/schema";
import { notFound } from "../../http/errors";
import { accountsView, cents, fromCents, loadLedger, newestPaymentsFirst, paymentQuery, paymentRow } from "../ledger/ledger";
import { unitSymbol } from "../orders/orders.routes";
import { buildOrderReports, ORDER_STATES, orderReportsQuery } from "../reports/order-reports";
import { supplierOrders } from "../reports/supplier-orders";

// Supplier Full History (Supplier 360°, owner approval of 2026-11-25; docs/supplier-history.md). Read-only: every figure
// comes from the existing calculations (loadLedger and its FIFO projection, buildOrderReports / supplierOrders with
// Dollar Cost and loadLandedCosts, paymentQuery); nothing here computes money its own way. History that was never
// recorded (edits, deleted receipts, earlier rates) is not reconstructed: an event has only what its source row holds.

/** The user named on a row (an order's creator, a receipt's recorder). */
const author = alias(users, "history_author");

export const PAGE_SIZE = 25;
const day = z.iso.date().optional();
const page = z
  .string()
  .regex(/^[1-9]\d{0,14}$/)
  .transform(Number)
  .optional();
const search = z.string().trim().max(100).optional();
const common = { from: day, to: day, q: search, page, all: z.literal("1").optional() };
const dates = (q: { from?: string; to?: string }) => !q.from || !q.to || q.from <= q.to;

/** Every kind of event the timeline can show, in the order the filters list them. */
export const EVENT_TYPES = [
  "supplier_created",
  "order_placed",
  "order_value_posted",
  "order_value_changed",
  "order_cancelled",
  "receipt_recorded",
  "payment_recorded",
  "payment_voided",
  "management_adjustment",
  "agent_payment",
  "agent_payment_voided",
  "container_loaded",
  "clearing_recorded",
  "transport_recorded",
  "warehouse_stocked",
  "landed_cost_final",
  "account_held",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const EVENT_STATUSES = ["active", "voided", "held", "migrated"] as const;

const eventsShape = {
  ...common,
  /** Comma-separated event types; unknown names are 400. */
  types: z
    .string()
    .transform((value) => value.split(",").filter(Boolean))
    .pipe(z.array(z.enum(EVENT_TYPES)))
    .optional(),
  status: z.enum(EVENT_STATUSES).optional(),
};
export const eventsQuery = z.strictObject(eventsShape).refine(dates);
/** RPT-SH: the same filters, the supplier optional (every supplier when left out). */
export const reportQuery = z.strictObject({ ...eventsShape, supplierId: z.uuid().optional() }).refine(dates);
export const ordersQuery = z.strictObject({ ...common, status: z.enum(ORDER_STATES).optional() }).refine(dates);
export const paymentsQuery = z.strictObject({ ...common, status: z.enum(["active", "voided"]).optional() }).refine(dates);
export const receiptsQuery = z.strictObject(common).refine(dates);
export const landedCostQuery = z.strictObject({ ...common, status: z.enum(["final", "estimate", "none"]).optional() }).refine(dates);

/** A page of rows (all of them with `all`, for the downloads). */
function pageOf<T>(rows: T[], q: { page?: number; all?: "1" }, size = PAGE_SIZE) {
  if (q.all) return { rows, page: 1, pageSize: rows.length, total: rows.length };
  const pageNumber = q.page ?? 1;
  return { rows: rows.slice((pageNumber - 1) * size, pageNumber * size), page: pageNumber, pageSize: size, total: rows.length };
}
const matches = (q: string | undefined, ...texts: (string | null | undefined)[]) => !q || texts.some((text) => text?.toLowerCase().includes(q.toLowerCase()));
const inRange = (date: string | null, q: { from?: string; to?: string }) => (!q.from || (date !== null && date >= q.from)) && (!q.to || (date !== null && date <= q.to));
const isoDay = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

async function supplierOr404(db: Database, id: string) {
  if (!z.uuid().safeParse(id).success) throw notFound("Supplier");
  const [row] = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      code: suppliers.code,
      status: suppliers.status,
      currency: suppliers.currency,
      exchangeRate: suppliers.exchangeRate,
      rateUpdatedAt: suppliers.rateUpdatedAt,
      contactPerson: suppliers.contactPerson,
      phone: suppliers.phone,
      email: suppliers.email,
      country: suppliers.country,
      city: suppliers.city,
      paymentTerms: suppliers.paymentTerms,
      createdAt: suppliers.createdAt,
    })
    .from(suppliers)
    .where(eq(suppliers.id, id));
  if (!row) throw notFound("Supplier");
  return row;
}
/** The few supplier facts every section answers with (the profile's header needs no second request). */
const brief = (row: Awaited<ReturnType<typeof supplierOr404>>) => ({ id: row.id, name: row.name, code: row.code, status: row.status });

// ---------------------------------------------------------------------------------------------------------------------
// SH-1 Overview: the live accounts apart from the historical totals, per currency.

export async function supplierOverview(db: Database, supplierId: string) {
  const supplier = await supplierOr404(db, supplierId);
  const [ledger, { report }, credits, holdRows, counts] = await Promise.all([
    loadLedger(db, { supplierIds: [supplierId] }),
    buildOrderReports(db, orderReportsQuery.parse({ supplierId })),
    // The ledger's own payment credits and voids (legacy advance receipts included): the active total is their sum.
    db
      .select({
        currency: entries.currency,
        entryType: entries.entryType,
        total: sql<number>`sum(${entries.amount})`.mapWith(Number),
        count: sql<number>`count(*)`.mapWith(Number),
        first: sql<string | null>`min(${entries.entryDate})::text`,
        last: sql<string | null>`max(${entries.entryDate})::text`,
      })
      .from(entries)
      .where(and(eq(entries.supplierId, supplierId), inArray(entries.entryType, ["payment", "payment_void", "adjustment"])))
      .groupBy(entries.currency, entries.entryType),
    db.select({ currency: holds.currency, reason: holds.reason, since: holds.createdAt }).from(holds).where(eq(holds.supplierId, supplierId)),
    db
      .select({
        receipts: sql<number>`(select count(*) from ${receipts} r join ${orders} o on o.id = r.order_id where o.supplier_id = ${supplierId})`.mapWith(Number),
        firstReceipt: sql<string | null>`(select min(r.received_on)::text from ${receipts} r join ${orders} o on o.id = r.order_id where o.supplier_id = ${supplierId})`,
        lastReceipt: sql<string | null>`(select max(r.received_on)::text from ${receipts} r join ${orders} o on o.id = r.order_id where o.supplier_id = ${supplierId})`,
        firstOrder: sql<string | null>`(select min(order_date)::text from ${orders} where supplier_id = ${supplierId})`,
        lastOrder: sql<string | null>`(select max(order_date)::text from ${orders} where supplier_id = ${supplierId})`,
        agentPayments: sql<number>`(select count(*) from ${payments} p join ${orders} o on o.id = p.order_id where p.payee_role = 'agent' and o.supplier_id = ${supplierId})`.mapWith(Number),
      })
      .from(sql`(select 1) one`),
  ]);
  const heldSet = new Set(holdRows.map((row) => row.currency));
  const currencies = [...new Set([...report.summary.byCurrency.map((t) => t.currency), ...credits.map((c) => c.currency), ...accountsView(ledger, supplierId).map((a) => a.currency)])].sort(compareCurrencies);
  const pick = (currency: string, type: string) => credits.find((c) => c.currency === currency && c.entryType === type);
  const dates = [counts[0]!.firstOrder, counts[0]!.firstReceipt, ...credits.map((c) => c.first)].filter(Boolean).sort() as string[];
  const lastDates = [counts[0]!.lastOrder, counts[0]!.lastReceipt, ...credits.map((c) => c.last)].filter(Boolean).sort() as string[];
  return {
    supplier: { ...supplier, rateUpdatedAt: supplier.rateUpdatedAt?.toISOString() ?? null, createdAt: supplier.createdAt.toISOString() },
    /** Live: the ledger's accounts now (balance + available with the supplier, − payable). Null figures while held. */
    accounts: accountsView(ledger, supplierId),
    holds: holdRows.map((row) => ({ currency: row.currency, reason: row.reason, since: row.since.toISOString() })),
    /** Historical totals per currency (never added across currencies). A held account's orders count in none (D4). */
    totals: currencies.map((currency) => {
      const orderTotals = report.summary.byCurrency.find((t) => t.currency === currency);
      const held = heldSet.has(currency);
      const paid = pick(currency, "payment");
      const voided = pick(currency, "payment_void");
      const adjusted = pick(currency, "adjustment");
      return {
        currency,
        held,
        orders: report.rows.filter((row) => row.currency === currency).length,
        poValue: orderTotals?.poValueCny ?? 0,
        orderValue: orderTotals?.orderValueCny ?? 0,
        settled: orderTotals?.settledCny ?? 0,
        outstanding: orderTotals?.outstandingCny ?? 0,
        /** Payments recorded less their voids (the ledger's credits from payments): voids are never counted. */
        paymentsActive: held ? null : fromCents(cents(paid?.total ?? 0) + cents(voided?.total ?? 0)),
        paymentsRecorded: paid?.count ?? 0,
        paymentsVoided: voided?.count ?? 0,
        /** Net of Management adjustments (LED-3). */
        adjustments: held ? null : fromCents(cents(adjusted?.total ?? 0)),
      };
    }),
    dollarCost: report.summary.dollarCost,
    landedCostInr: report.summary.landedCostInr,
    activity: { first: dates[0] ?? null, last: lastDates.at(-1) ?? null },
    counts: { orders: report.rows.length, receipts: counts[0]!.receipts, agentPayments: counts[0]!.agentPayments },
  };
}

/**
 * SH-0: the profile header of every history tab: the supplier, its holds and the ledger's accounts now. The same three
 * parts as SH-1, without SH-1's historical totals (an order report of every order), so a tab never computes them twice.
 */
export async function supplierHeader(db: Database, supplierId: string) {
  const supplier = await supplierOr404(db, supplierId);
  const [ledger, holdRows] = await Promise.all([
    loadLedger(db, { supplierIds: [supplierId] }),
    db.select({ currency: holds.currency, reason: holds.reason, since: holds.createdAt }).from(holds).where(eq(holds.supplierId, supplierId)),
  ]);
  return {
    supplier: { ...supplier, rateUpdatedAt: supplier.rateUpdatedAt?.toISOString() ?? null, createdAt: supplier.createdAt.toISOString() },
    accounts: accountsView(ledger, supplierId),
    holds: holdRows.map((row) => ({ currency: row.currency, reason: row.reason, since: row.since.toISOString() })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// SH-2 Orders: RPT-S1's rows of the supplier (the same figures as the Order Report), paged.

export async function supplierHistoryOrders(db: Database, supplierId: string, q: z.infer<typeof ordersQuery>) {
  const supplier = brief(await supplierOr404(db, supplierId));
  const [result, protections] = await Promise.all([
    supplierOrders(db, orderReportsQuery.parse({ supplierId, po: q.q, from: q.from, to: q.to, status: q.status })),
    db.select({ orderId: finalCostProtections.orderId, at: finalCostProtections.protectedAt }).from(finalCostProtections).where(eq(finalCostProtections.supplierId, supplierId)),
  ]);
  const protectedAt = new Map(protections.map((row) => [row.orderId, row.at.toISOString()]));
  const group = result.suppliers[0];
  const rows = (group?.rows ?? []).map((row) => ({ ...row, protectedAt: protectedAt.get(row.id) ?? null }));
  return { supplier, orders: pageOf(rows, q), byCurrency: group?.byCurrency ?? [], dollarCost: group?.dollarCost ?? { usd: 0, missing: 0 } };
}

// ---------------------------------------------------------------------------------------------------------------------
// SH-3 Payments: every supplier payment (orderless and legacy order-linked) and legacy advance credit, with its ledger
// postings and the orders the live FIFO projection settles from it (derived now, not a stored allocation).

const supplierOfPayment = sql`coalesce(${payments.supplierId}, ${orders.supplierId})`;

export async function supplierHistoryPayments(db: Database, supplierId: string, q: z.infer<typeof paymentsQuery>) {
  const supplier = brief(await supplierOr404(db, supplierId));
  const [paymentRows, postings, advanceCredits, ledger, orderPos] = await Promise.all([
    paymentQuery(db, and(sql`${supplierOfPayment} = ${supplierId}`, eq(payments.payeeRole, "supplier"))).orderBy(...newestPaymentsFirst),
    db
      .select({ id: entries.id, paymentId: entries.paymentId, entryType: entries.entryType, amount: entries.amount, origin: entries.origin, notes: entries.notes, createdAt: entries.createdAt })
      .from(entries)
      .where(and(eq(entries.supplierId, supplierId), isNotNull(entries.paymentId))),
    db
      .select({
        entryId: entries.id,
        advanceId: advances.id,
        currency: entries.currency,
        amount: entries.amount,
        entryDate: entries.entryDate,
        origin: entries.origin,
        createdAt: entries.createdAt,
        mode: advances.mode,
        reference: advances.reference,
        notes: advances.notes,
        rate: advances.exchangeRate,
      })
      .from(entries)
      .innerJoin(advances, eq(advances.id, entries.advanceEntryId))
      .where(eq(entries.supplierId, supplierId)),
    loadLedger(db, { supplierIds: [supplierId] }),
    db.select({ id: orders.id, po: orders.poNumber }).from(orders).where(eq(orders.supplierId, supplierId)),
  ]);
  // The live FIFO projection, read backwards: which order each credit settles now.
  const poOf = new Map(orderPos.map((row) => [row.id, row.po]));
  const settles = new Map<string, { po: string; amount: number }[]>();
  for (const settlement of ledger.orders.values()) {
    for (const slice of settlement.slices) {
      const key = slice.paymentId ?? slice.advanceEntryId;
      if (!key) continue;
      settles.set(key, [...(settles.get(key) ?? []), { po: poOf.get(settlement.orderId) ?? "", amount: slice.amount }]);
    }
  }
  const postingsOf = (paymentId: string) => postings.filter((row) => row.paymentId === paymentId);
  const rows = [
    ...paymentRows.map((raw) => {
      const row = paymentRow(raw);
      const own = postingsOf(row.id);
      const credit = own.find((p) => p.entryType === "payment");
      return {
        ...row,
        source: "payment" as const,
        recordedBy: raw.recordedBy || null,
        migrated: credit?.origin === "backfill",
        ledgerCredit: credit ? credit.amount : null,
        ledgerVoid: own.find((p) => p.entryType === "payment_void")?.amount ?? null,
        settlesNow: row.voided ? [] : (settles.get(row.id) ?? []),
      };
    }),
    ...advanceCredits.map((credit) => ({
      id: credit.advanceId,
      orderId: null,
      po: null,
      supplierId,
      supplier: "",
      currency: credit.currency,
      kind: "Advance",
      payee: "",
      payeeRole: "supplier" as const,
      amountCny: credit.amount,
      status: "paid" as const,
      paidOn: credit.entryDate,
      dueDate: null,
      rateInr: credit.rate,
      amountInr: credit.rate === null ? null : Math.round(credit.amount * credit.rate * 100) / 100,
      mode: credit.mode,
      reference: credit.reference,
      notes: credit.notes,
      recordedAt: credit.createdAt.toISOString(),
      voided: false,
      voidedAt: null,
      voidedBy: null,
      voidReason: "",
      held: ledger.account(supplierId, credit.currency)?.held ?? false,
      source: "advance" as const,
      recordedBy: null,
      migrated: credit.origin === "backfill",
      ledgerCredit: credit.amount,
      ledgerVoid: null,
      settlesNow: settles.get(credit.advanceId) ?? [],
    })),
  ]
    .filter((row) => (!q.status || (q.status === "voided") === row.voided) && inRange(row.paidOn, q) && matches(q.q, row.reference, row.po, row.mode, row.notes, row.kind))
    .sort((a, b) => (b.paidOn ?? "").localeCompare(a.paidOn ?? "") || b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
  // Per currency, from the ledger's postings: active = credits − voids (a voided payment counts in no total).
  const currencies = [...new Set(rows.map((row) => row.currency))].sort(compareCurrencies);
  const totals = currencies.map((currency) => {
    const inCurrency = rows.filter((row) => row.currency === currency && !row.held);
    return {
      currency,
      active: fromCents(inCurrency.reduce((total, row) => total + cents(row.ledgerCredit ?? 0) + cents(row.ledgerVoid ?? 0), 0)),
      count: inCurrency.filter((row) => !row.voided).length,
      voided: inCurrency.filter((row) => row.voided).length,
    };
  });
  return { supplier, payments: pageOf(rows, q), totals };
}

// ---------------------------------------------------------------------------------------------------------------------
// SH-4 Receiving: every China goods receipt of the supplier's orders with its lines, the containers carrying those
// lines and the India warehouse's split per line. A deleted receipt is not kept anywhere: it is not listed.

export async function supplierHistoryReceipts(db: Database, supplierId: string, q: z.infer<typeof receiptsQuery>) {
  const supplier = brief(await supplierOr404(db, supplierId));
  const receiptRows = await db
    .select({
      id: receipts.id,
      orderId: receipts.orderId,
      po: orders.poNumber,
      currency: orders.currency,
      receivedOn: receipts.receivedOn,
      location: locations.name,
      // The signed-in user who recorded the receipt (REC-1 stores their id; every screen shows it as "Received by").
      receivedBy: sql<string | null>`${author.name}`,
      bundles: receipts.bundles,
      deliveryNote: receipts.deliveryNote,
      shortRemark: receipts.shortRemark,
      recordedAt: receipts.createdAt,
    })
    .from(receipts)
    .innerJoin(orders, eq(orders.id, receipts.orderId))
    .innerJoin(locations, eq(locations.id, receipts.locationId))
    .leftJoin(author, eq(author.id, receipts.receivedBy))
    .where(eq(orders.supplierId, supplierId))
    .orderBy(desc(receipts.receivedOn), desc(receipts.createdAt), desc(receipts.id));
  const kept = receiptRows.filter((row) => inRange(row.receivedOn, q) && matches(q.q, row.po, row.deliveryNote, row.receivedBy, row.shortRemark));
  const paged = pageOf(kept, q);
  const ids = paged.rows.map((row) => row.id);
  const [lines, carried, stocked] = ids.length
    ? await Promise.all([
        db
          .select({ receiptId: receiptLines.receiptId, orderLineId: receiptLines.orderLineId, item: items.name, unit: unitSymbol, quantity: receiptLines.quantity })
          .from(receiptLines)
          .innerJoin(orderLines, eq(orderLines.id, receiptLines.orderLineId))
          .innerJoin(items, eq(items.id, orderLines.itemId))
          .where(inArray(receiptLines.receiptId, ids))
          .orderBy(asc(orderLines.position)),
        db
          .select({ orderLineId: containerLines.orderLineId, number: containers.number, quantity: containerLines.quantity })
          .from(containerLines)
          .innerJoin(containers, eq(containers.id, containerLines.containerId))
          .innerJoin(receiptLines, eq(receiptLines.orderLineId, containerLines.orderLineId))
          .where(inArray(receiptLines.receiptId, ids))
          .groupBy(containerLines.orderLineId, containers.number, containerLines.quantity),
        db
          .select({ orderLineId: warehouseReceiptLines.orderLineId, team: teams.name, quantity: sql<number>`sum(${warehouseReceiptLines.quantity})`.mapWith(Number) })
          .from(warehouseReceiptLines)
          .innerJoin(warehouseReceipts, and(eq(warehouseReceipts.id, warehouseReceiptLines.receiptId), eq(warehouseReceipts.status, "stocked")))
          .innerJoin(teams, eq(teams.id, warehouseReceiptLines.teamId))
          .innerJoin(receiptLines, eq(receiptLines.orderLineId, warehouseReceiptLines.orderLineId))
          .where(inArray(receiptLines.receiptId, ids))
          .groupBy(warehouseReceiptLines.orderLineId, teams.name),
      ])
    : [[], [], []];
  return {
    supplier,
    receipts: {
      ...paged,
      rows: paged.rows.map((row) => ({
        ...row,
        recordedAt: row.recordedAt.toISOString(),
        lines: lines
          .filter((line) => line.receiptId === row.id)
          .map(({ receiptId: _r, orderLineId, ...line }) => ({
            ...line,
            /** Containers carrying the order line (all of its loads, not only this receipt's goods). */
            containers: carried.filter((c) => c.orderLineId === orderLineId).map(({ orderLineId: _l, ...c }) => c),
            /** The India warehouse's split of the order line by team (stocked receipts); never counted in order value. */
            warehouse: stocked.filter((s) => s.orderLineId === orderLineId).map(({ orderLineId: _l, ...s }) => s),
          })),
      })),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// SH-5 Landed cost: loadLandedCosts' parts per order (through RPT-S1), when each became final and protected, the
// agent (sea-freight) payments apart from the supplier's, and the container-level clearing and transport records.

export async function supplierHistoryLandedCost(db: Database, supplierId: string, q: z.infer<typeof landedCostQuery>) {
  const supplier = brief(await supplierOr404(db, supplierId));
  const [result, protections, agentRows] = await Promise.all([
    supplierOrders(db, orderReportsQuery.parse({ supplierId, po: q.q, from: q.from, to: q.to })),
    db.select({ orderId: finalCostProtections.orderId, at: finalCostProtections.protectedAt }).from(finalCostProtections).where(eq(finalCostProtections.supplierId, supplierId)),
    paymentQuery(db, and(eq(orders.supplierId, supplierId), eq(payments.payeeRole, "agent"))).orderBy(...newestPaymentsFirst),
  ]);
  const protectedAt = new Map(protections.map((row) => [row.orderId, row.at.toISOString()]));
  const rows = (result.suppliers[0]?.rows ?? []).filter(
    (row) => !q.status || (q.status === "none" ? row.landedCost === null : row.landedCost !== null && row.landedCost.final === (q.status === "final")),
  );
  const paged = pageOf(rows, q);
  const containerNumbers = [...new Set(paged.rows.flatMap((row) => row.containers.map((c) => c.number)))];
  const [clearingRows, tripRows] = containerNumbers.length
    ? await Promise.all([
        db
          .select({
            container: containers.number,
            status: clearings.status,
            billOfEntry: clearings.billOfEntry,
            clearedOn: clearings.clearedOn,
            customsDutyInr: clearings.customsDutyInr,
            otherDutiesInr: clearings.otherDutiesInr,
            agentChargesInr: clearings.agentChargesInr,
            portChargesInr: clearings.portChargesInr,
          })
          .from(clearings)
          .innerJoin(containers, eq(containers.id, clearings.containerId))
          .where(inArray(containers.number, containerNumbers)),
        db
          .select({ container: containers.number, status: transports.status, lrNumber: transports.lrNumber, unloadedOn: transports.unloadedOn, freightInr: transports.freightInr, handlingInr: transports.handlingInr })
          .from(transports)
          .innerJoin(containers, eq(containers.id, transports.containerId))
          .where(inArray(containers.number, containerNumbers)),
      ])
    : [[], []];
  const agents = agentRows.map((raw) => ({ ...paymentRow(raw), recordedBy: raw.recordedBy || null }));
  return {
    supplier,
    orders: {
      ...paged,
      rows: paged.rows.map((row) => ({
        id: row.id,
        po: row.po,
        orderDate: row.orderDate,
        currency: row.currency,
        stage: row.stage,
        held: row.held,
        orderValueCny: row.orderValueCny,
        landedCost: row.landedCost,
        protectedAt: protectedAt.get(row.id) ?? null,
        containers: row.containers.map((c) => ({
          ...c,
          /** The container's own records (shared by every order in it; the order's share is in landedCost). */
          clearing: clearingRows.find((r) => r.container === c.number) ?? null,
          transport: tripRows.find((r) => r.container === c.number) ?? null,
        })),
        agentPayments: agents.filter((payment) => payment.orderId === row.id),
      })),
    },
    landedCostInr: result.suppliers[0]?.landedCostInr ?? 0,
    agentPayments: { count: agents.length, voided: agents.filter((a) => a.voided).length },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// SH-6 / RPT-SH Events: one timeline from every source that records something, each event with only what its row holds.

export type HistoryEvent = {
  id: string;
  type: EventType;
  /** The business date the user entered (null when the source has none: then the recorded day is used for filters). */
  date: string | null;
  /** When the database recorded it; for a migrated posting, the cutover (23 Nov 2026), not when it happened. */
  recordedAt: string | null;
  origin: "app" | "migrated";
  /** Who recorded it; null when the source keeps no author ("Not recorded"); "Removed user" when the user is gone. */
  actor: string | null;
  supplier: { id: string; name: string; code: string };
  currency: string | null;
  /** Signed as in the ledger: + a credit, − a debit; agent payments positive in the order's currency. */
  amount: number | null;
  amountInr: number | null;
  po: string | null;
  reference: string | null;
  details: string;
  reason: string | null;
  status: "active" | "voided" | "held" | null;
};

const actorOf = (id: string | null, name: string | null) => (id === null ? null : (name ?? "Removed user"));
/** Only the note prefixes the application writes are read; anything else stays a plain value change. */
const valueChangeCause = (notes: string) =>
  notes.startsWith("Rate correction:") ? "Rate correction" : notes.startsWith("Revaluation to received quantity") ? "Revaluation to received quantity" : null;

export async function supplierEvents(db: Database, scope: { supplierId?: string }) {
  const bySupplier = (column: SQL | typeof orders.supplierId) => (scope.supplierId ? sql`${column} = ${scope.supplierId}` : undefined);
  const supplierRows = await db
    .select({ id: suppliers.id, name: suppliers.name, code: suppliers.code, createdAt: suppliers.createdAt, createdBy: suppliers.createdBy, actor: author.name })
    .from(suppliers)
    .leftJoin(author, eq(author.id, suppliers.createdBy))
    .where(scope.supplierId ? eq(suppliers.id, scope.supplierId) : undefined);
  const supplierOf = new Map(supplierRows.map((row) => [row.id, { id: row.id, name: row.name, code: row.code }]));
  const containerSuppliers = sql`(select distinct ${orders.supplierId} as supplier_id, ${containerLines.containerId} as container_id from ${containerLines}
    join ${orderLines} on ${orderLines.id} = ${containerLines.orderLineId} join ${orders} on ${orders.id} = ${orderLines.orderId})`;
  const posOf = (containerId: SQL) =>
    sql<string>`(select string_agg(distinct ${orders.poNumber}, ', ') from ${containerLines} join ${orderLines} on ${orderLines.id} = ${containerLines.orderLineId}
      join ${orders} on ${orders.id} = ${orderLines.orderId} where ${containerLines.containerId} = ${containerId} and ${orders.supplierId} = cs.supplier_id)`;

  const [ledgerRows, holdRows, orderRows, receiptRows, receiptLineRows, agentRows, containerRows, clearingRows, tripRows, stockRows, protectionRows] = await Promise.all([
    db
      .select({
        id: entries.id,
        supplierId: entries.supplierId,
        currency: entries.currency,
        entryType: entries.entryType,
        amount: entries.amount,
        exchangeRate: entries.exchangeRate,
        entryDate: entries.entryDate,
        origin: entries.origin,
        createdAt: entries.createdAt,
        createdBy: entries.createdBy,
        actor: author.name,
        po: entries.poNumber,
        notes: entries.notes,
        paymentVoidedAt: payments.voidedAt,
        mode: sql<string | null>`coalesce(${payments.mode}, ${advances.mode})`,
        reference: sql<string | null>`coalesce(nullif(${payments.reference}, ''), nullif(${advances.reference}, ''))`,
        legacyAdvance: sql<boolean>`${entries.advanceEntryId} is not null`,
      })
      .from(entries)
      .leftJoin(payments, eq(payments.id, entries.paymentId))
      .leftJoin(advances, eq(advances.id, entries.advanceEntryId))
      .leftJoin(author, eq(author.id, entries.createdBy))
      .where(bySupplier(sql`${entries.supplierId}`)),
    db.select({ supplierId: holds.supplierId, currency: holds.currency, reason: holds.reason, createdAt: holds.createdAt }).from(holds).where(bySupplier(sql`${holds.supplierId}`)),
    db
      .select({ id: orders.id, supplierId: orders.supplierId, po: orders.poNumber, currency: orders.currency, orderDate: orders.orderDate, createdAt: orders.createdAt, createdBy: orders.createdBy, actor: author.name })
      .from(orders)
      .leftJoin(author, eq(author.id, orders.createdBy))
      .where(bySupplier(sql`${orders.supplierId}`)),
    db
      .select({
        id: receipts.id,
        supplierId: orders.supplierId,
        po: orders.poNumber,
        receivedOn: receipts.receivedOn,
        createdAt: receipts.createdAt,
        receivedBy: sql<string | null>`${author.name}`,
        bundles: receipts.bundles,
        deliveryNote: receipts.deliveryNote,
        shortRemark: receipts.shortRemark,
      })
      .from(receipts)
      .innerJoin(orders, eq(orders.id, receipts.orderId))
      .leftJoin(author, eq(author.id, receipts.receivedBy))
      .where(bySupplier(sql`${orders.supplierId}`)),
    db
      .select({ receiptId: receiptLines.receiptId, unit: unitSymbol, quantity: sql<number>`sum(${receiptLines.quantity})`.mapWith(Number) })
      .from(receiptLines)
      .innerJoin(orderLines, eq(orderLines.id, receiptLines.orderLineId))
      .innerJoin(items, eq(items.id, orderLines.itemId))
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
      .where(bySupplier(sql`${orders.supplierId}`))
      .groupBy(receiptLines.receiptId, unitSymbol),
    paymentQuery(db, and(eq(payments.payeeRole, "agent"), scope.supplierId ? eq(orders.supplierId, scope.supplierId) : undefined)),
    db.execute<{ id: string; supplier_id: string; number: string; loaded_on: string | null; created_at: Date; created_by: string | null; actor: string | null; status: string; terms: string; pos: string }>(sql`
      select c.id, cs.supplier_id, c.number, c.loaded_on::text, c.created_at, c.created_by, u.name as actor, c.status, c.terms, ${posOf(sql`c.id`)} as pos
      from ${containerSuppliers} cs join ${containers} c on c.id = cs.container_id left join ${users} u on u.id = c.created_by
      ${scope.supplierId ? sql`where cs.supplier_id = ${scope.supplierId}` : sql``}`),
    db.execute<{ id: string; supplier_id: string; number: string; day: string | null; created_at: Date; created_by: string; actor: string | null; status: string; bill_of_entry: string; total: string; pos: string }>(sql`
      select cl.id, cs.supplier_id, c.number, coalesce(cl.cleared_on, cl.duty_paid_on, cl.arrived_on)::text as day, cl.created_at, cl.created_by, u.name as actor, cl.status,
        cl.bill_of_entry, (cl.customs_duty_inr + cl.other_duties_inr + cl.agent_charges_inr + cl.port_charges_inr)::text as total, ${posOf(sql`c.id`)} as pos
      from ${containerSuppliers} cs join ${containers} c on c.id = cs.container_id join ${clearings} cl on cl.container_id = c.id left join ${users} u on u.id = cl.created_by
      ${scope.supplierId ? sql`where cs.supplier_id = ${scope.supplierId}` : sql``}`),
    db.execute<{ id: string; supplier_id: string; number: string; day: string | null; created_at: Date; created_by: string; actor: string | null; status: string; lr_number: string; total: string; pos: string }>(sql`
      select t.id, cs.supplier_id, c.number, coalesce(t.unloaded_on, t.loaded_on)::text as day, t.created_at, t.created_by, u.name as actor, t.status, t.lr_number,
        (t.freight_inr + t.handling_inr)::text as total, ${posOf(sql`c.id`)} as pos
      from ${containerSuppliers} cs join ${containers} c on c.id = cs.container_id join ${transports} t on t.container_id = c.id left join ${users} u on u.id = t.created_by
      ${scope.supplierId ? sql`where cs.supplier_id = ${scope.supplierId}` : sql``}`),
    db.execute<{ id: string; supplier_id: string; number: string; day: string; created_at: Date; created_by: string; actor: string | null; status: string; pos: string }>(sql`
      select w.id, cs.supplier_id, c.number, w.received_on::text as day, w.created_at, w.created_by, u.name as actor, w.status, ${posOf(sql`c.id`)} as pos
      from ${containerSuppliers} cs join ${containers} c on c.id = cs.container_id join ${transports} t on t.container_id = c.id
      join ${warehouseReceipts} w on w.transport_id = t.id left join ${users} u on u.id = w.created_by
      ${scope.supplierId ? sql`where cs.supplier_id = ${scope.supplierId}` : sql``}`),
    db
      .select({ orderId: finalCostProtections.orderId, supplierId: finalCostProtections.supplierId, currency: finalCostProtections.currency, at: finalCostProtections.protectedAt, po: orders.poNumber })
      .from(finalCostProtections)
      .innerJoin(orders, eq(orders.id, finalCostProtections.orderId))
      .where(bySupplier(sql`${finalCostProtections.supplierId}`)),
  ]);

  const held = new Set(holdRows.map((row) => `${row.supplierId} ${row.currency}`));
  const supplier = (id: string) => supplierOf.get(id) ?? { id, name: "", code: "" };
  const events: HistoryEvent[] = [];
  const push = (event: Omit<HistoryEvent, "supplier" | "origin" | "amountInr" | "reason" | "status"> & Partial<Pick<HistoryEvent, "origin" | "amountInr" | "reason" | "status">> & { supplierId: string }) => {
    const { supplierId, ...rest } = event;
    events.push({ origin: "app", amountInr: null, reason: null, status: null, ...rest, supplier: supplier(supplierId) });
  };

  for (const row of supplierRows) {
    push({ id: `supplier:${row.id}`, type: "supplier_created", supplierId: row.id, date: isoDay(row.createdAt), recordedAt: row.createdAt.toISOString(), actor: actorOf(row.createdBy, row.actor), currency: null, amount: null, po: null, reference: null, details: "Supplier added" });
  }
  for (const row of orderRows) {
    push({ id: `order:${row.id}`, type: "order_placed", supplierId: row.supplierId, date: row.orderDate, recordedAt: row.createdAt.toISOString(), actor: actorOf(row.createdBy, row.actor), currency: row.currency, amount: null, po: row.po, reference: null, details: "Order placed", status: held.has(`${row.supplierId} ${row.currency}`) ? "held" : "active" });
  }
  for (const row of ledgerRows) {
    const isHeld = held.has(`${row.supplierId} ${row.currency}`);
    const base = {
      id: `ledger:${row.id}`,
      supplierId: row.supplierId,
      date: row.entryDate,
      recordedAt: row.createdAt.toISOString(),
      origin: row.origin === "backfill" ? ("migrated" as const) : ("app" as const),
      actor: actorOf(row.createdBy, row.actor),
      currency: row.currency,
      amount: row.amount,
      amountInr: row.exchangeRate === null ? null : Math.round(row.amount * row.exchangeRate * 100) / 100,
      po: row.po || null,
      reference: row.reference,
    };
    const status = isHeld ? ("held" as const) : ("active" as const);
    switch (row.entryType) {
      case "order_debit":
        // A debit of 0 (an order placed with nothing received) adds nothing to "Order placed".
        if (row.amount !== 0) push({ ...base, type: "order_value_posted", details: row.origin === "backfill" ? "Order value at the ledger's start" : "Order value posted", status });
        break;
      case "order_adjustment":
        push({ ...base, type: "order_value_changed", details: valueChangeCause(row.notes) ?? "Order value change", reason: row.notes || null, status });
        break;
      case "order_cancel":
        push({ ...base, type: "order_cancelled", details: "Order deleted; its value given back", reason: row.notes || null, status });
        break;
      case "payment":
        push({
          ...base,
          type: "payment_recorded",
          details: row.legacyAdvance ? "Legacy advance receipt (archive), in the ledger" : `Payment${row.mode ? ` · ${row.mode}` : ""}`,
          status: isHeld ? "held" : row.paymentVoidedAt ? "voided" : "active",
        });
        break;
      case "payment_void":
        push({ ...base, type: "payment_voided", details: "Payment voided", reason: row.notes || null, status });
        break;
      case "adjustment":
        push({ ...base, type: "management_adjustment", details: "Management adjustment", reason: row.notes || null, status });
        break;
    }
  }
  for (const row of receiptRows) {
    const quantities = receiptLineRows.filter((line) => line.receiptId === row.id).map((line) => `${line.quantity} ${line.unit}`);
    push({
      id: `receipt:${row.id}`,
      type: "receipt_recorded",
      supplierId: row.supplierId,
      date: row.receivedOn,
      recordedAt: row.createdAt.toISOString(),
      // REC-1 stores the signed-in user who recorded the receipt (shown everywhere as "Received by").
      actor: row.receivedBy,
      currency: null,
      amount: null,
      po: row.po,
      reference: row.deliveryNote || null,
      details: [`Received ${quantities.join(" · ") || "nothing"}`, `${row.bundles} bundles`, row.shortRemark || null].filter(Boolean).join(" · "),
    });
  }
  for (const raw of agentRows) {
    const row = paymentRow(raw);
    push({
      id: `agent:${row.id}`,
      type: "agent_payment",
      supplierId: row.supplierId,
      date: row.paidOn ?? row.dueDate,
      recordedAt: row.recordedAt,
      actor: raw.recordedBy || null,
      currency: row.currency,
      amount: row.amountCny,
      amountInr: row.amountInr,
      po: row.po,
      reference: row.reference || null,
      details: `Sea freight to ${row.payee}${row.mode ? ` · ${row.mode}` : ""} (not in the supplier's ledger)`,
      status: row.voided ? "voided" : "active",
    });
    if (row.voided) {
      push({ id: `agent-void:${row.id}`, type: "agent_payment_voided", supplierId: row.supplierId, date: row.voidedAt!.slice(0, 10), recordedAt: row.voidedAt, actor: row.voidedBy || null, currency: row.currency, amount: row.amountCny, amountInr: row.amountInr, po: row.po, reference: row.reference || null, details: `Sea freight payment to ${row.payee} voided`, reason: row.voidReason || null, status: "voided" });
    }
  }
  for (const row of containerRows.rows) {
    push({ id: `container:${row.id}:${row.supplier_id}`, type: "container_loaded", supplierId: row.supplier_id, date: row.loaded_on, recordedAt: new Date(row.created_at).toISOString(), actor: actorOf(row.created_by, row.actor), currency: null, amount: null, po: row.pos, reference: row.number, details: `Container ${row.number} (${row.terms}) · ${row.status}` });
  }
  for (const row of clearingRows.rows) {
    push({ id: `clearing:${row.id}:${row.supplier_id}`, type: "clearing_recorded", supplierId: row.supplier_id, date: row.day, recordedAt: new Date(row.created_at).toISOString(), actor: actorOf(row.created_by, row.actor), currency: "INR", amount: null, amountInr: Number(row.total), po: row.pos, reference: row.bill_of_entry || row.number, details: `Clearing of ${row.number} · ${row.status} · container charges (shared by its orders)` });
  }
  for (const row of tripRows.rows) {
    push({ id: `transport:${row.id}:${row.supplier_id}`, type: "transport_recorded", supplierId: row.supplier_id, date: row.day, recordedAt: new Date(row.created_at).toISOString(), actor: actorOf(row.created_by, row.actor), currency: "INR", amount: null, amountInr: Number(row.total), po: row.pos, reference: row.lr_number || row.number, details: `Transport of ${row.number} · ${row.status} · freight and handling (shared by its orders)` });
  }
  for (const row of stockRows.rows) {
    push({ id: `warehouse:${row.id}:${row.supplier_id}`, type: "warehouse_stocked", supplierId: row.supplier_id, date: row.day, recordedAt: new Date(row.created_at).toISOString(), actor: actorOf(row.created_by, row.actor), currency: null, amount: null, po: row.pos, reference: row.number, details: `Warehouse receipt of ${row.number} · ${row.status}` });
  }
  for (const row of protectionRows) {
    push({ id: `final:${row.orderId}`, type: "landed_cost_final", supplierId: row.supplierId, date: isoDay(row.at), recordedAt: row.at.toISOString(), actor: null, currency: row.currency, amount: null, po: row.po, reference: null, details: "Landed cost final: settlement protected" });
  }
  for (const row of holdRows) {
    push({ id: `hold:${row.supplierId}:${row.currency}`, type: "account_held", supplierId: row.supplierId, date: isoDay(row.createdAt), recordedAt: row.createdAt.toISOString(), actor: null, currency: row.currency, amount: null, po: null, reference: null, details: `Account in ${row.currency} on hold (pending review)`, reason: row.reason, status: "held" });
  }
  // Latest first: the business date (or the recorded day when there is none), then the recorded moment, then the id.
  const key = (event: HistoryEvent) => event.date ?? event.recordedAt?.slice(0, 10) ?? "";
  return events.sort((a, b) => key(b).localeCompare(key(a)) || (b.recordedAt ?? "").localeCompare(a.recordedAt ?? "") || b.id.localeCompare(a.id));
}

/** The timeline filtered and paged (SH-6 for one supplier, RPT-SH for one or every supplier). */
export function filterEvents(events: HistoryEvent[], q: z.infer<typeof eventsQuery>) {
  const kept = events.filter((event) => {
    const day = event.date ?? event.recordedAt?.slice(0, 10) ?? null;
    if (!inRange(day, q)) return false;
    if (q.types?.length && !q.types.includes(event.type)) return false;
    if (q.status === "migrated" ? event.origin !== "migrated" : q.status && event.status !== q.status) return false;
    return matches(q.q, event.po, event.reference, event.details, event.reason, event.supplier.name, event.supplier.code);
  });
  const byType = Object.fromEntries(EVENT_TYPES.map((type) => [type, kept.filter((event) => event.type === type).length]).filter(([, count]) => count));
  return { events: pageOf(kept, q), byType };
}

export async function supplierHistoryEvents(db: Database, supplierId: string, q: z.infer<typeof eventsQuery>) {
  const supplier = brief(await supplierOr404(db, supplierId));
  return { supplier, ...filterEvents(await supplierEvents(db, { supplierId }), q) };
}

/** RPT-SH: the timeline of one supplier or of every supplier, with the page's select options and the filter echo. */
export async function supplierHistoryReport(db: Database, q: z.infer<typeof reportQuery>) {
  const [events, options] = await Promise.all([
    supplierEvents(db, { supplierId: q.supplierId }),
    db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).orderBy(asc(suppliers.name)),
  ]);
  const supplier = q.supplierId ? options.find((row) => row.id === q.supplierId) : undefined;
  return {
    ...filterEvents(events, q),
    filter: { supplier: supplier?.name ?? null, from: q.from ?? null, to: q.to ?? null, types: q.types ?? [], status: q.status ?? null, q: q.q ?? null },
    options: { suppliers: options, types: EVENT_TYPES, statuses: EVENT_STATUSES },
  };
}

