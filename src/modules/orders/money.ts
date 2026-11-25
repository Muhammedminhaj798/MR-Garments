import { and, eq, isNotNull, type SQL, sql } from "drizzle-orm";

import type { Database } from "../../db/client";
import { orderLines, orders, payments, suppliers } from "../../db/schema";
import { cents, depositMilestone, fromCents, type OrderSettlement, settlementFields } from "../ledger/ledger";
import { receivedOfLine } from "../ledger/received";

// The money of the order in the row (`orders.id`), as correlated subqueries. Supplier money is the unified ledger's
// (docs/unified-ledger.md): every order's settled, outstanding and payment status come from the FIFO projection
// (`loadLedger`), never from payments named on the order. What stays here is the order's value (received quantity ×
// rate) and PO value (ordered quantity × rate, reference only), its shipping-agent
// payments (sea freight: never in the ledger) and its due rows. A voided payment counts in none of them.
//
// The fragments correlate on `orders.id`, so they belong in a select FROM orders that has at least one join (in a
// single-table select drizzle drops the table name from the outer columns and the inner table would shadow them).

export const round2 = (value: number) => Math.round(value * 100) / 100;

// A voided payment counts nowhere; nor does any payment of a held account (D4: listed as a record, in no figure).
const notHeld = sql`not exists (select 1 from supplier_ledger_holds h where h.supplier_id = ${orders.supplierId} and h.currency = ${orders.currency})`;
const ofOrder = sql`${payments.orderId} = ${orders.id} and ${payments.voidedAt} is null and ${notHeld}`;
const paidToAgent = sql`${ofOrder} and ${payments.payeeRole} = 'agent' and ${payments.status} = 'paid'`;
/** Due (not yet paid) supplier payments of the order, not voided. */
export const dueToSupplier = sql`${ofOrder} and ${payments.payeeRole} = 'supplier' and ${payments.status} = 'due'`;

const sumCny = (where: SQL) => sql<number>`(select coalesce(sum(${payments.amountCny}), 0) from ${payments} where ${where})`.mapWith(Number);
/** INR is amountCny * rateInr rounded to 2 decimals per payment, then summed (the same paisa on every screen). */
const sumInr = (where: SQL) =>
  sql<number>`(select coalesce(sum(round(${payments.amountCny} * ${payments.rateInr}, 2)), 0) from ${payments} where ${where})`.mapWith(Number);

// Each correlation is its own fragment, nested: drizzle keeps a nested fragment's table names, but drops them from a
// single-table select's top-level columns (so an inlined `orders.id` would become the subquery's own `id`).
const linesOfOrder = sql`${orderLines.orderId} = ${orders.id}`;

export const orderMoney = {
  /**
   * The order's value (owner rule of 2026-11-23): round(Σ received quantity × line rate, 2), received from the China
   * goods receipts (ledger.ts `receivedOfLine`, the one definition). It is what the journal holds for the order.
   */
  orderValueCny: sql<number>`(select round(coalesce(sum(${receivedOfLine} * ${orderLines.rateCny}), 0), 2) from ${orderLines} where ${linesOfOrder})`.mapWith(Number),
  /** The PO value, for reference only: round(Σ ordered quantity × line rate, 2). Never posted, never settled. */
  poValueCny: sql<number>`(select round(coalesce(sum(${orderLines.quantity} * ${orderLines.rateCny}), 0), 2) from ${orderLines} where ${linesOfOrder})`.mapWith(Number),
  /** Paid to shipping agents for the order: sea freight (landed cost), never the supplier's money. */
  agentPaidCny: sumCny(paidToAgent),
  agentPaidInr: sumInr(paidToAgent),
  /** The earliest due payment, or null. */
  nextDue: sql<string | null>`(select min(${payments.dueDate})::text from ${payments} where ${ofOrder} and ${payments.status} = 'due')`,
};

/**
 * Dollar Cost (owner decisions of 2026-11-24): the order's value (received quantity × rate, `orderValueCny`) in USD. The
 * one definition every report and export uses. A USD order: its value. Nothing received (value 0): 0. Any other
 * currency: at the two rates saved on the order when it was placed, round(value × exchange_rate ÷ usd_rate, 2) (INR per
 * 1 of its currency, INR per 1 USD); null (no USD rate saved) without both. Today's rate never re-prices a past order.
 * Works on a line's value too (same currency and rates as its order).
 */
export const dollarCost = (row: { currency: string; orderValueCny: number; exchangeRate: number | null; usdRate: number | null }) =>
  row.currency === "USD" || row.orderValueCny === 0
    ? row.orderValueCny
    : row.exchangeRate !== null && row.usdRate !== null
      ? round2((row.orderValueCny * row.exchangeRate) / row.usdRate)
      : null;

/**
 * Dollar Cost added up (callers leave a held account's orders out, as from every total): `usd` only when every one is
 * known (a part total would read as the whole), and how many have no USD rate.
 */
export function dollarCostTotal(values: (number | null)[]) {
  const missing = values.filter((value) => value === null).length;
  return { usd: missing ? null : fromCents(values.reduce((total: number, value) => total + cents(value ?? 0), 0)), missing };
}

/**
 * The USD rate in force now (INR per 1 USD), what a new non-USD order saves as `usd_rate` (0019, owner decisions of
 * 2026-11-24): the one rate the active USD suppliers with a rate agree on (Settings › Suppliers, the existing
 * exchange-rate mechanism). Null, never a pick, when none has a rate or their rates differ. Migration 0019 gave
 * historical orders the same rule's rate only where the records prove it for the moment they were entered.
 */
export async function usdRateNow(db: Pick<Database, "select">) {
  const rates = await db
    .select({ rate: suppliers.exchangeRate })
    .from(suppliers)
    .where(and(eq(suppliers.currency, "USD"), eq(suppliers.status, "Active"), isNotNull(suppliers.exchangeRate)))
    .groupBy(suppliers.exchangeRate);
  return rates.length === 1 ? rates[0]!.rate : null;
}

/**
 * The order's money for a response from its settlement (FIFO projection) and its own figures: SettlementFields,
 * MilestoneFields, the agent payments and `paidInr` = goods INR (settledInr) + agent INR, null while settledInr is.
 */
export function orderSettlement(settlement: OrderSettlement | undefined, row: { depositRequiredCny: number | null; agentPaidCny: number; agentPaidInr: number }) {
  const figures = settlementFields(settlement);
  // A held account's order (D4) carries no money figure at all, its sea freight included.
  const held = settlement?.held ?? false;
  return {
    ...figures,
    ...depositMilestone(row.depositRequiredCny, settlement),
    agentPaidCny: held ? null : row.agentPaidCny,
    agentPaidInr: held ? null : row.agentPaidInr,
    paidInr: figures.settledInr === null ? null : fromCents(cents(figures.settledInr) + cents(row.agentPaidInr)),
  };
}

/** The same fields for a user without payments View: money null; the order's held flag and deposit term stay. */
export function hiddenSettlement(held: boolean, depositRequiredCny: number | null) {
  return {
    held,
    settledCny: null,
    outstandingCny: null,
    paymentStatus: null,
    settledInr: null,
    depositRequiredCny,
    depositSettledCny: null,
    depositPendingCny: null,
    depositStatus: depositRequiredCny === null ? ("none" as const) : null,
    agentPaidCny: null,
    agentPaidInr: null,
    paidInr: null,
  };
}
