import { type SQL, sql } from "drizzle-orm";

import { orderLines, orders, payments } from "../../db/schema";

// The money of the order in the row (`orders.id`), as correlated subqueries: the one place the payee rules live
// (docs/phase2-fixes.md section 1). Every list, detail, report and statement reads these, so a figure called the same
// thing is the same figure everywhere. Agent payments are sea freight (docs/wave3-contracts.md 6.2): they count in
// `paidCny`/`paidInr` (what left the company for the order) and never in the supplier figures, the balance or the
// deposit against what the supplier asked for.
//
// The fragments correlate on `orders.id`, so they belong in a select FROM orders that has at least one join (in a
// single-table select drizzle drops the table name from the outer columns and the inner table would shadow them).

export const round2 = (value: number) => Math.round(value * 100) / 100;

const ofOrder = sql`${payments.orderId} = ${orders.id}`;
const paid = sql`${ofOrder} and ${payments.status} = 'paid'`;
/** Payments of the order to its supplier, paid or due. */
export const toSupplier = sql`${ofOrder} and ${payments.payeeRole} = 'supplier'`;
const paidToSupplier = sql`${paid} and ${payments.payeeRole} = 'supplier'`;

const sumCny = (where: SQL) => sql<number>`(select coalesce(sum(${payments.amountCny}), 0) from ${payments} where ${where})`.mapWith(Number);
/** INR is amountCny * rateInr rounded to 2 decimals per payment, then summed (the same paisa on every screen). */
const sumInr = (where: SQL) =>
  sql<number>`(select coalesce(sum(round(${payments.amountCny} * ${payments.rateInr}, 2)), 0) from ${payments} where ${where})`.mapWith(Number);

// Each correlation is its own fragment, nested: drizzle keeps a nested fragment's table names, but drops them from a
// single-table select's top-level columns (so an inlined `orders.id` would become the subquery's own `id`).
const linesOfOrder = sql`${orderLines.orderId} = ${orders.id}`;

export const orderMoney = {
  orderValueCny: sql<number>`(select round(coalesce(sum(${orderLines.quantity} * ${orderLines.rateCny}), 0), 2) from ${orderLines} where ${linesOfOrder})`.mapWith(Number),
  /** Every paid payment, agents included. */
  paidCny: sumCny(paid),
  paidInr: sumInr(paid),
  /** Paid to the supplier only: the order's balance, payment status and deposit figures read these. */
  supplierPaidCny: sumCny(paidToSupplier),
  supplierPaidInr: sumInr(paidToSupplier),
  /** Paid supplier deposits: what counts against `orders.deposit_required_cny`. */
  depositPaidCny: sumCny(sql`${paidToSupplier} and ${payments.kind} = 'Deposit'`),
  /** The earliest due payment, or null. */
  nextDue: sql<string | null>`(select min(${payments.dueDate})::text from ${payments} where ${ofOrder} and ${payments.status} = 'due')`,
};

/** 13.5's names for the supplier-only figures (Payments per supplier, its detail, the order reports, warehouse outstanding). */
export const supplierMoney = { orderValueCny: orderMoney.orderValueCny, paidCny: orderMoney.supplierPaidCny, paidInr: orderMoney.supplierPaidInr };

export const DEPOSIT_STATUSES = ["none", "due", "partly", "paid"] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

/**
 * The order's deposit against what the supplier asked for (0009): `none` when no deposit was agreed; otherwise `due`
 * (nothing paid yet), `partly`, or `paid` (paid supplier deposits reach the requirement; more is kept as paid, never
 * as a negative pending). Pure, so the lists, the detail, the Deposits page and the report agree.
 */
export function depositState(required: number | null, paid: number) {
  if (required === null) return { depositRequiredCny: null, depositPaidCny: paid, depositPendingCny: null, depositStatus: "none" as DepositStatus };
  const pending = Math.max(0, round2(required - paid));
  const depositStatus: DepositStatus = paid <= 0 ? "due" : pending === 0 ? "paid" : "partly";
  return { depositRequiredCny: required, depositPaidCny: paid, depositPendingCny: pending, depositStatus };
}
