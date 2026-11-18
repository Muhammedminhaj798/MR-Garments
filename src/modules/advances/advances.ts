import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
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

/** What an entry does to the available advance: + for receipts, excess and reversals; - for allocations and excess returns. */
export const signedAmount = sql`case when ${a.kind} in ('allocation', 'excess_return') then -${a.amount} else ${a.amount} end`;
/** The entries that take money out of the available advance (amount counts negative). */
const takesOut = (kind: string) => kind === "allocation" || kind === "excess_return";

/**
 * Order deposits (owner decision 2026-11-18, docs/supplier-advance.md): a paid supplier deposit on an order (entered on
 * New order, ORD-3, or recorded later as a Deposit payment, PAY-2) is advance money already applied to its own order.
 * The payments row stays its only record. The advance account reads it here as recorded and applied at once, so it never
 * changes the available advance, and the order money still counts it once, as a supplier payment (orderMoney).
 * Agent deposits and due rows are not supplier money paid.
 */
export const isOrderDeposit = and(eq(payments.kind, "Deposit"), eq(payments.payeeRole, "supplier"), eq(payments.status, "paid"))!;

/** Per supplier and currency: received, allocated, reversed, available and how many POs the account was applied to. */
export function advanceTotals(db: Pick<Database, "select">, where: SQL = sql`true`) {
  const sumOf = (kind: string) => sql<number>`coalesce(sum(${a.amount}) filter (where ${a.kind} = ${kind}), 0)`.mapWith(Number);
  return db
    .select({
      supplierId: a.supplierId,
      currency: a.currency,
      receivedCny: sumOf("receipt"),
      /** Supplier money paid on orders beyond their value, net of what was taken back (0016). */
      excessCny: sql<number>`(${sumOf("excess")} - ${sumOf("excess_return")})`.mapWith(Number),
      allocatedCny: sumOf("allocation"),
      reversedCny: sumOf("reversal"),
      availableCny: sql<number>`coalesce(sum(${signedAmount}), 0)`.mapWith(Number),
      // Orders the advance was applied to: live ones by id; a deleted one (order_id null) by its PO, which a later order may reuse.
      orders: sql<number>`count(distinct coalesce(${a.orderId}::text, 'deleted ' || lower(${a.poNumber}))) filter (where ${a.kind} in ('allocation', 'reversal'))`.mapWith(Number),
    })
    .from(a)
    .where(where)
    .groupBy(a.supplierId, a.currency);
}

/** What a lot has given out: allocations less their reversals, plus excess returns taken from it. */
const drawnFrom = sql`select coalesce(sum(case when e.kind = 'reversal' then -e.amount else e.amount end), 0)
    from ${a} e where e.advance_id = ${a.id} and e.kind in ('allocation', 'reversal', 'excess_return')`;

/**
 * What is left of each lot in the currency, oldest first (paid on, then recorded): the order allocations draw in. A lot
 * is a receipt (advance added) or an excess (supplier money paid on an order beyond its value, 0016).
 */
function lots(tx: Pick<Database, "select">, supplierId: string, currency: string) {
  return tx
    .select({ id: a.id, exchangeRate: a.exchangeRate, remaining: sql<number>`${a.amount} - (${drawnFrom})`.mapWith(Number) })
    .from(a)
    .where(and(eq(a.supplierId, supplierId), eq(a.currency, currency), inArray(a.kind, ["receipt", "excess"])))
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
  const money = await owedOf(tx, order.id);
  // First the order's excess (supplier payments beyond its value), so its own allocations never draw on it.
  const excessCny = await syncExcess(tx, order, money, userId);
  const available = await lots(tx, order.supplierId, order.currency);
  const applied = await allocationsOf(tx, order.id);
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
    /** What the supplier is still owed for the order after the advance and direct payments (never below 0). */
    balanceCny: fromCents(Math.max(0, balanceCents)),
    /** Supplier payments beyond the order's value, now available supplier advance (0016). */
    excessCny,
    status: advanceStatus(fromCents(target), fromCents(Math.max(0, balanceCents))),
  };
}

/**
 * Brings the order's excess (its paid supplier payments beyond its value) to max(0, paid - value), under the supplier's
 * advance lock. More excess: one `excess` lot per payment, newest payment first, each carrying that payment's day,
 * mode, reference and rate. Less: `excess_return` from the order's newest lots, out of what is still free in each; when
 * other orders already drew on a lot, their allocations are given back first (newest first; they owe that again).
 * Returns the order's excess after the call.
 */
async function syncExcess(tx: Tx, order: AdvanceOrder, money: { valueCny: number; directPaidCny: number }, userId: string) {
  const target = Math.max(0, cents(money.directPaidCny) - cents(money.valueCny));
  const returned = sql`select coalesce(sum(r.amount), 0) from ${a} r where r.advance_id = ${a.id} and r.kind = 'excess_return'`;
  const drawn = sql`select coalesce(sum(case when e.kind = 'reversal' then -e.amount else e.amount end), 0)
    from ${a} e where e.advance_id = ${a.id} and e.kind in ('allocation', 'reversal')`;
  const mine = await tx
    .select({
      id: a.id,
      paymentId: a.paymentId,
      exchangeRate: a.exchangeRate,
      net: sql<number>`${a.amount} - (${returned})`.mapWith(Number),
      drawn: sql<number>`(${drawn})`.mapWith(Number),
    })
    .from(a)
    .where(and(eq(a.orderId, order.id), eq(a.kind, "excess")))
    .orderBy(desc(a.createdAt), desc(a.id));
  const current = mine.reduce((sum, lot) => sum + cents(lot.net), 0);
  const base = { supplierId: order.supplierId, currency: order.currency, orderId: order.id, poNumber: order.po, createdBy: userId };
  const rows: (typeof a.$inferInsert)[] = [];

  if (target > current) {
    // Newest payments first: the latest money is the money beyond what the order needed.
    const paidRows = await tx
      .select({ id: payments.id, amount: payments.amountCny, rate: payments.rateInr, paidOn: payments.paidOn, mode: payments.mode, reference: payments.reference })
      .from(payments)
      .where(and(eq(payments.orderId, order.id), eq(payments.status, "paid"), eq(payments.payeeRole, "supplier")))
      .orderBy(desc(payments.paidOn), desc(payments.createdAt), desc(payments.id));
    let left = target - current;
    for (const payment of paidRows) {
      const already = mine.filter((lot) => lot.paymentId === payment.id).reduce((sum, lot) => sum + cents(lot.net), 0);
      const take = Math.min(left, cents(payment.amount) - already);
      if (take > 0)
        rows.push({
          ...base,
          kind: "excess",
          amount: fromCents(take),
          exchangeRate: payment.rate ?? 1,
          entryDate: payment.paidOn ?? todayInIndia(),
          mode: payment.mode ?? "",
          reference: payment.reference,
          paymentId: payment.id,
        });
      left -= Math.max(0, take);
    }
  } else if (target < current) {
    let need = current - target;
    for (const lot of mine) {
      if (need <= 0) break;
      const lotNet = cents(lot.net);
      if (lotNet <= 0) continue;
      let free = lotNet - cents(lot.drawn);
      // Other orders drew more than is free: give their allocations back first, newest first.
      if (free < Math.min(need, lotNet)) {
        const usedBy = await tx
          .select({
            id: a.id,
            orderId: a.orderId,
            poNumber: a.poNumber,
            applied: sql<number>`${a.amount} - (select coalesce(sum(r.amount), 0) from ${a} r where r.reversal_of = ${a.id})`.mapWith(Number),
          })
          .from(a)
          .where(and(eq(a.advanceId, lot.id), eq(a.kind, "allocation")))
          .orderBy(desc(a.createdAt), desc(a.id));
        let release = Math.min(need, lotNet) - free;
        for (const allocation of usedBy) {
          const give = Math.min(release, cents(allocation.applied));
          if (give > 0) {
            rows.push({
              supplierId: order.supplierId,
              currency: order.currency,
              orderId: allocation.orderId,
              poNumber: allocation.poNumber,
              createdBy: userId,
              kind: "reversal",
              amount: fromCents(give),
              exchangeRate: lot.exchangeRate,
              advanceId: lot.id,
              reversalOf: allocation.id,
              entryDate: todayInIndia(),
            });
            release -= give;
            free += give;
          }
        }
      }
      const take = Math.min(need, lotNet, free);
      if (take > 0) rows.push({ ...base, kind: "excess_return", amount: fromCents(take), exchangeRate: lot.exchangeRate, advanceId: lot.id, entryDate: todayInIndia() });
      need -= take;
    }
  }
  if (rows.length > 0) await tx.insert(a).values(rows);
  return fromCents(target);
}

/** The part of a payment that is excess (its excess lots less what was returned of them), correlated on payments.id. */
const excessOfPayment = sql`(select coalesce(sum(case when xe.kind = 'excess' then xe.amount else -xe.amount end), 0)
  from ${a} xe left join ${a} xl on xl.id = xe.advance_id
  where (xe.kind = 'excess' and xe.payment_id = ${payments.id}) or (xe.kind = 'excess_return' and xl.payment_id = ${payments.id}))`;

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
  /** The lot an allocation, reversal or excess return draws from or returns to, its paid-on day and reference. */
  advanceId: a.advanceId,
  /** An excess: the supplier payment it is part of (null once that payment is deleted). */
  paymentId: a.paymentId,
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

/** Oldest first: (the day,) the moment recorded, then rows of one insert in the order of the lots they draw from. */
const inLedgerOrder = (byDay: boolean) => [
  ...(byDay ? [asc(a.entryDate)] : []),
  asc(a.createdAt),
  sql`${receiptOf.entryDate} asc nulls first`,
  sql`${receiptOf.createdAt} asc nulls first`,
  asc(a.id),
];

/** The order's allocations and reversals, oldest first (ORD-4, the order report). */
export function orderAdvanceEntries(db: Pick<Database, "select">, orderId: string) {
  // Only what was applied to the order; its own excess (money it paid beyond its value) is shown apart (excessCny).
  return db
    .select(entryColumns)
    .from(a)
    .leftJoin(receiptOf, eq(receiptOf.id, a.advanceId))
    .leftJoin(orders, eq(orders.id, a.orderId))
    .leftJoin(users, eq(users.id, a.createdBy))
    .where(and(eq(a.orderId, orderId), inArray(a.kind, ["allocation", "reversal"])))
    .orderBy(...inLedgerOrder(false));
}

/** The money behind every order key: a live order by id, a deleted one (ledger rows only) by its PO. */
const orderKey = sql`coalesce(${a.orderId}::text, 'deleted ' || lower(${a.poNumber}))`;

/**
 * What the advance screens and reports show per supplier and currency (DEP-1, ADV-1, SD-1, RPT-5D): the ledger's totals,
 * the order deposits (`depositsCny`) and every order either touched (`orders`). `availableCny` is the ledger's alone:
 * an order deposit is applied in full to its own order. Allocation reads advanceTotals, never this.
 */
export async function advanceSummary(db: Pick<Database, "select">, supplierId?: string) {
  const [ledger, ledgerOrders, deposits] = await Promise.all([
    advanceTotals(db, supplierId ? eq(a.supplierId, supplierId) : sql`true`),
    db
      .select({ supplierId: a.supplierId, currency: a.currency, keys: sql<string[]>`array_agg(distinct ${orderKey})` })
      .from(a)
      .where(and(inArray(a.kind, ["allocation", "reversal"]), supplierId ? eq(a.supplierId, supplierId) : sql`true`))
      .groupBy(a.supplierId, a.currency),
    db
      .select({
        supplierId: orders.supplierId,
        currency: orders.currency,
        depositsCny: sql<number>`sum(${payments.amountCny} - ${excessOfPayment})`.mapWith(Number),
        keys: sql<string[]>`array_agg(distinct ${orders.id}::text) filter (where ${payments.amountCny} - ${excessOfPayment} > 0)`,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(and(isOrderDeposit, supplierId ? eq(orders.supplierId, supplierId) : sql`true`))
      .groupBy(orders.supplierId, orders.currency),
  ]);
  const key = (row: { supplierId: string; currency: string }) => `${row.supplierId} ${row.currency}`;
  const rows = new Map<string, { supplierId: string; currency: string; receivedCny: number; excessCny: number; allocatedCny: number; reversedCny: number; availableCny: number; depositsCny: number; orders: number }>();
  const touched = new Map<string, Set<string>>();
  const rowOf = (from: { supplierId: string; currency: string }) => {
    if (!rows.has(key(from))) rows.set(key(from), { supplierId: from.supplierId, currency: from.currency, receivedCny: 0, excessCny: 0, allocatedCny: 0, reversedCny: 0, availableCny: 0, depositsCny: 0, orders: 0 });
    return rows.get(key(from))!;
  };
  // `orders` is replaced below by the orders of both kinds.
  for (const row of ledger) Object.assign(rowOf(row), row);
  for (const row of deposits) rowOf(row).depositsCny = fromCents(cents(row.depositsCny));
  for (const row of [...ledgerOrders, ...deposits]) touched.set(key(row), new Set([...(touched.get(key(row)) ?? []), ...(row.keys ?? [])]));
  for (const [k, row] of rows) row.orders = touched.get(k)?.size ?? 0;
  // A deposit wholly beyond its order's value settles nothing: its money is all in the excess.
  return [...rows.values()].filter((row) => row.receivedCny || row.excessCny || row.allocatedCny || row.reversedCny || row.depositsCny);
}

/**
 * One supplier's order deposits (see isOrderDeposit), newest first: paid on, then recorded. `amount` is what the deposit
 * settled of its order; the part beyond the order's value is in the account as an excess (`paidAmount` is the whole
 * payment). A deposit wholly beyond its order's value is left out (all of it is excess).
 */
export async function orderDepositEntries(db: Pick<Database, "select">, supplierId: string) {
  const settled = sql`(${payments.amountCny} - ${excessOfPayment})`;
  const rows = await db
    .select({
      /** The payment's id: the order's Payments tab and PAY-3 act on it, never this account. */
      id: payments.id,
      orderId: payments.orderId,
      po: orders.poNumber,
      paidOn: sql<string>`${payments.paidOn}::text`,
      currency: orders.currency,
      amount: sql<number>`${settled}`.mapWith(Number),
      paidAmount: payments.amountCny,
      /** INR per 1 of `currency`, as typed on the payment. */
      exchangeRate: payments.rateInr,
      amountInr: sql<number>`round(${settled} * ${payments.rateInr}, 2)`.mapWith(Number),
      mode: payments.mode,
      reference: payments.reference,
      notes: payments.notes,
      recordedAt: payments.createdAt,
      recordedBy: sql<string>`coalesce(${users.name}, '')`,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .leftJoin(users, eq(users.id, payments.createdBy))
    .where(and(isOrderDeposit, eq(orders.supplierId, supplierId)))
    .orderBy(desc(payments.paidOn), desc(payments.createdAt), desc(payments.id));
  return rows.filter((row) => row.amount > 0);
}

/**
 * One supplier's advance account (ADV-1, the statements and reports): totals per currency (CNY, USD, INR, then by
 * code; advanceSummary), every ledger entry newest first with `balance`, the available advance in its currency right
 * after it, and the order deposits (`deposits`), each with the available advance on its day (unchanged by it: it is
 * applied to its own order). The running order is the ledger's own: day, then the moment it was recorded.
 */
export async function advanceAccount(db: Pick<Database, "select">, supplierId: string) {
  const [totals, rows, deposits] = await Promise.all([
    advanceSummary(db, supplierId),
    db
      .select(entryColumns)
      .from(a)
      .leftJoin(receiptOf, eq(receiptOf.id, a.advanceId))
      .leftJoin(orders, eq(orders.id, a.orderId))
      .leftJoin(users, eq(users.id, a.createdBy))
      .where(eq(a.supplierId, supplierId))
      .orderBy(...inLedgerOrder(true)),
    orderDepositEntries(db, supplierId),
  ]);
  const running = new Map<string, number>();
  const entries = rows.map((row) => {
    const balance = (running.get(row.currency) ?? 0) + (takesOut(row.kind) ? -cents(row.amount) : cents(row.amount));
    running.set(row.currency, balance);
    return { ...row, balance: fromCents(balance) };
  });
  // The available advance at the end of the deposit's day: the last ledger entry in its currency on or before it
  // (`entries` is still oldest first here).
  const balanceOn = (currency: string, day: string) => entries.findLast((row) => row.currency === currency && row.entryDate <= day)?.balance ?? 0;
  const withBalance = deposits.map((row) => ({ ...row, balance: balanceOn(row.currency, row.paidOn) }));
  return {
    summary: totals.map(({ supplierId: _supplierId, ...row }) => row).sort((x, y) => compareCurrencies(x.currency, y.currency)),
    entries: entries.toReversed(),
    deposits: withBalance,
  };
}
export type AdvanceAccount = Awaited<ReturnType<typeof advanceAccount>>;
