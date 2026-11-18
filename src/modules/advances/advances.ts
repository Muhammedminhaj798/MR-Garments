import { and, asc, desc, eq, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { compareCurrencies } from "../../currencies";
import type { Database } from "../../db/client";
import { orderLines, orders, payments, supplierAdvanceEntries as a, users } from "../../db/schema";
import { todayInIndia } from "../stages/common";

// The supplier advance account (docs/supplier-advance.md, migration 0014): the one place that writes allocations and
// reversals and sums the ledger. Every write to one supplier's account (receipt, allocation, reversal, receipt delete)
// runs under lockAdvances, so two orders can never draw the same money. Arithmetic is in whole cents (integers), so
// nothing is lost to floating point; amounts stay far below 2^53 cents.

type Tx = Pick<Database, "select" | "insert" | "execute">;

const cents = (value: number) => Math.round(value * 100);
const fromCents = (value: number) => value / 100;

/** Serialises writes to one supplier's advance account until the transaction ends. Taken after any row lock the caller holds. */
export async function lockAdvances(tx: Pick<Database, "execute">, supplierId: string) {
  // The two-key form: its keys never collide with the one-key locks elsewhere (orders.po_number).
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('supplier-advance'), hashtext(${supplierId}))`);
}

/** +amount for receipts and reversals, -amount for allocations: what an entry does to the available advance. */
export const signedAmount = sql`case when ${a.kind} = 'allocation' then -${a.amount} else ${a.amount} end`;

/** Per supplier and currency: received, allocated, reversed, available and how many POs the account was applied to. */
export function advanceTotals(db: Pick<Database, "select">, where: SQL = sql`true`) {
  const sumOf = (kind: string) => sql<number>`coalesce(sum(${a.amount}) filter (where ${a.kind} = ${kind}), 0)`.mapWith(Number);
  return db
    .select({
      supplierId: a.supplierId,
      currency: a.currency,
      receivedCny: sumOf("receipt"),
      allocatedCny: sumOf("allocation"),
      reversedCny: sumOf("reversal"),
      availableCny: sql<number>`coalesce(sum(${signedAmount}), 0)`.mapWith(Number),
      // Live orders by id; a deleted one (order_id null) by its PO, which a later order may reuse.
      orders: sql<number>`count(distinct coalesce(${a.orderId}::text, 'deleted ' || lower(${a.poNumber}))) filter (where ${a.kind} <> 'receipt')`.mapWith(Number),
    })
    .from(a)
    .where(where)
    .groupBy(a.supplierId, a.currency);
}

/** What is left of each receipt in the currency, oldest first (paid on, then recorded): the order allocations draw in. */
function lots(tx: Pick<Database, "select">, supplierId: string, currency: string) {
  const drawn = sql`select coalesce(sum(case when e.kind = 'allocation' then e.amount else -e.amount end), 0)
    from ${a} e where e.advance_id = ${a.id}`;
  return tx
    .select({ id: a.id, exchangeRate: a.exchangeRate, remaining: sql<number>`${a.amount} - (${drawn})`.mapWith(Number) })
    .from(a)
    .where(and(eq(a.supplierId, supplierId), eq(a.currency, currency), eq(a.kind, "receipt")))
    .orderBy(asc(a.entryDate), asc(a.createdAt), asc(a.id));
}

/** The order's allocations with what is still applied of each (amount less its reversals), newest first: the order releases in. */
function allocationsOf(tx: Pick<Database, "select">, orderId: string) {
  const reversed = sql`select coalesce(sum(r.amount), 0) from ${a} r where r.reversal_of = ${a.id}`;
  return tx
    .select({ id: a.id, advanceId: a.advanceId, exchangeRate: a.exchangeRate, applied: sql<number>`${a.amount} - (${reversed})`.mapWith(Number) })
    .from(a)
    .where(and(eq(a.orderId, orderId), eq(a.kind, "allocation")))
    .orderBy(desc(a.createdAt), desc(a.id));
}

/** The order's value and what was paid to its supplier directly (paid payments), from the database as it is now. */
async function owedOf(tx: Pick<Database, "select">, orderId: string) {
  const [value] = await tx
    .select({ total: sql<number>`round(coalesce(sum(${orderLines.quantity} * ${orderLines.rateCny}), 0), 2)`.mapWith(Number) })
    .from(orderLines)
    .where(eq(orderLines.orderId, orderId));
  const [paid] = await tx
    .select({ total: sql<number>`coalesce(sum(${payments.amountCny}), 0)`.mapWith(Number) })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid"), eq(payments.payeeRole, "supplier")));
  return { valueCny: value!.total, directPaidCny: paid!.total };
}

export type AdvanceOrder = { id: string; po: string; supplierId: string; currency: string };
export type AdvanceStatus = "none" | "partial" | "full";

/** None while nothing is applied; full once the advance (with any direct payments) leaves nothing to pay; partial otherwise. */
export const advanceStatus = (appliedCny: number, balanceCny: number): AdvanceStatus => (appliedCny <= 0 ? "none" : balanceCny <= 0 ? "full" : "partial");

/**
 * How far settleAdvance may go. `settle` (ORD-3, ORD-5, ADV-4): up to what the order still owes after direct supplier
 * payments, drawing more while advance is available. `cap` (PAY-2): never draws; only gives back what direct payments
 * now cover, so supplier payments plus advance never pass the order value. `release` (ORD-6): gives everything back.
 */
export type SettleMode = "settle" | "cap" | "release";

/**
 * Brings the advance applied to the order to its target (see SettleMode), in the order's currency, inside the caller's
 * transaction, which holds the order's row lock when the order exists already. More is drawn from the oldest receipts
 * first (one allocation per receipt); less gives back the newest allocations first (one reversal per allocation).
 * Idempotent: at the target, nothing is written, so a retried or repeated call never applies or returns money twice.
 */
export async function settleAdvance(tx: Tx, order: AdvanceOrder, userId: string, mode: SettleMode = "settle") {
  await lockAdvances(tx, order.supplierId);
  // One after another: a transaction is one connection.
  const available = await lots(tx, order.supplierId, order.currency);
  const applied = await allocationsOf(tx, order.id);
  const money = await owedOf(tx, order.id);
  const appliedCents = applied.reduce((sum, row) => sum + cents(row.applied), 0);
  const availableCents = available.reduce((sum, row) => sum + Math.max(0, cents(row.remaining)), 0);
  const owedCents = Math.max(0, cents(money.valueCny) - cents(money.directPaidCny));
  const target = mode === "release" ? 0 : Math.min(owedCents, mode === "cap" ? appliedCents : appliedCents + availableCents);
  const base = { supplierId: order.supplierId, currency: order.currency, orderId: order.id, poNumber: order.po, entryDate: todayInIndia(), createdBy: userId };

  const rows: (typeof a.$inferInsert)[] = [];
  let left = Math.abs(target - appliedCents);
  if (target > appliedCents) {
    for (const lot of available) {
      const take = Math.min(left, Math.max(0, cents(lot.remaining)));
      if (take > 0) rows.push({ ...base, kind: "allocation", amount: fromCents(take), exchangeRate: lot.exchangeRate, advanceId: lot.id });
      left -= take;
    }
  } else {
    for (const allocation of applied) {
      const give = Math.min(left, Math.max(0, cents(allocation.applied)));
      if (give > 0)
        rows.push({ ...base, kind: "reversal", amount: fromCents(give), exchangeRate: allocation.exchangeRate, advanceId: allocation.advanceId, reversalOf: allocation.id });
      left -= give;
    }
  }
  if (rows.length > 0) await tx.insert(a).values(rows);

  const balanceCents = cents(money.valueCny) - cents(money.directPaidCny) - target;
  return {
    appliedCny: fromCents(target),
    /** What this call drew (+) or gave back (-). */
    changeCny: fromCents(target - appliedCents),
    /** The supplier's advance left in the order's currency after this call. */
    availableCny: fromCents(availableCents - (target - appliedCents)),
    /** What the supplier is still owed for the order after the advance and direct payments. */
    balanceCny: fromCents(balanceCents),
    status: advanceStatus(fromCents(target), fromCents(balanceCents)),
  };
}

const receiptOf = alias(a, "advance_receipt");
const entryColumns = {
  id: a.id,
  kind: a.kind,
  entryDate: a.entryDate,
  currency: a.currency,
  amount: a.amount,
  /** INR per 1 of `currency`: the receipt's typed rate, carried by its allocations and reversals. */
  exchangeRate: a.exchangeRate,
  amountInr: sql<number>`round(${a.amount} * ${a.exchangeRate}, 2)`.mapWith(Number),
  /** The receipt an allocation or reversal draws from or returns to, its paid-on day and reference. */
  advanceId: a.advanceId,
  advancePaidOn: receiptOf.entryDate,
  advanceReference: receiptOf.reference,
  reversalOf: a.reversalOf,
  /** Null once the order was deleted. */
  orderId: a.orderId,
  /**
   * The order's PO number as it is now (ORD-5 may renumber an order); a deleted order's, as it was when the entry was
   * written. The stored po_number is never rewritten: it is the record of the number at the time.
   */
  po: sql<string>`coalesce(${orders.poNumber}, ${a.poNumber})`,
  mode: a.mode,
  reference: a.reference,
  notes: a.notes,
  recordedAt: a.createdAt,
  recordedBy: sql<string>`coalesce(${users.name}, '')`,
};

/** Oldest first: (the day,) the moment recorded, then rows of one insert in the order of the receipts they draw from. */
const inLedgerOrder = (byDay: boolean) => [
  ...(byDay ? [asc(a.entryDate)] : []),
  asc(a.createdAt),
  sql`${receiptOf.entryDate} asc nulls first`,
  sql`${receiptOf.createdAt} asc nulls first`,
  asc(a.id),
];

/** The order's allocations and reversals, oldest first (ORD-4, the order report). */
export function orderAdvanceEntries(db: Pick<Database, "select">, orderId: string) {
  return db
    .select(entryColumns)
    .from(a)
    .leftJoin(receiptOf, eq(receiptOf.id, a.advanceId))
    .leftJoin(orders, eq(orders.id, a.orderId))
    .leftJoin(users, eq(users.id, a.createdBy))
    .where(eq(a.orderId, orderId))
    .orderBy(...inLedgerOrder(false));
}

/**
 * One supplier's advance account (ADV-1, the statements and reports): totals per currency (CNY, USD, INR, then by
 * code) and every entry newest first with `balance`, the available advance in its currency right after it. The
 * running order is the ledger's own: day, then the moment it was recorded.
 */
export async function advanceAccount(db: Pick<Database, "select">, supplierId: string) {
  const [totals, rows] = await Promise.all([
    advanceTotals(db, eq(a.supplierId, supplierId)),
    db
      .select(entryColumns)
      .from(a)
      .leftJoin(receiptOf, eq(receiptOf.id, a.advanceId))
      .leftJoin(orders, eq(orders.id, a.orderId))
      .leftJoin(users, eq(users.id, a.createdBy))
      .where(eq(a.supplierId, supplierId))
      .orderBy(...inLedgerOrder(true)),
  ]);
  const running = new Map<string, number>();
  const entries = rows.map((row) => {
    const balance = (running.get(row.currency) ?? 0) + (row.kind === "allocation" ? -cents(row.amount) : cents(row.amount));
    running.set(row.currency, balance);
    return { ...row, balance: fromCents(balance) };
  });
  return {
    summary: totals.map(({ supplierId: _supplierId, ...row }) => row).sort((x, y) => compareCurrencies(x.currency, y.currency)),
    entries: entries.reverse(),
  };
}
export type AdvanceAccount = Awaited<ReturnType<typeof advanceAccount>>;
