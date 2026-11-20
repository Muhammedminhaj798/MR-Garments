import { and, asc, desc, eq, inArray, like, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { compareCurrencies } from "../../currencies";
import type { Database } from "../../db/client";
import {
  type Currency,
  ledgerState,
  type LedgerEntryType,
  type LedgerOrigin,
  orderLines,
  orders,
  payments,
  supplierAdvanceEntries as advances,
  supplierLedgerEntries as e,
  supplierLedgerHolds as holds,
  suppliers,
  users,
} from "../../db/schema";
import { conflict, HttpError } from "../../http/errors";
import { todayInIndia } from "../stages/common";

// The unified supplier ledger (migration 0017, docs/unified-ledger.md). The one place that writes the journal, holds the
// write-state guard and the account holds, and derives every supplier balance and per-order settlement (the FIFO
// projection). Money is handled in whole cents (integers) so nothing is lost to floating point.

type Tx = Pick<Database, "select" | "insert" | "execute">;
type Reader = Pick<Database, "select">;

export const cents = (value: number) => Math.round(value * 100);
export const fromCents = (value: number) => value / 100;
/**
 * INR of an amount (in cents) at a rate (at most 4 decimals), rounded to the paisa half away from zero exactly as SQL
 * `round(amount * rate, 2)` does on numerics, so a void's INR is always minus its payment's. Integer (BigInt) arithmetic:
 * amounts and rates fit numeric(14,2) and numeric(12,4). Null without a rate.
 */
export function inrOf(amountCents: number, rate: number | null) {
  if (rate === null) return null;
  const product = BigInt(Math.abs(amountCents)) * BigInt(Math.round(rate * 10_000));
  let paise = product / 10_000n;
  if ((product % 10_000n) * 2n >= 10_000n) paise += 1n;
  return (Math.sign(amountCents) * Number(paise)) / 100;
}

export const MESSAGES = {
  maintenance: "Payments and order money are paused for maintenance. Try again later.",
  held: "This supplier's account is pending review.",
};

const accountKey = (supplierId: string, currency: string) => `${supplierId} ${currency}`;

// ---------------------------------------------------------------------------------------------------------------------
// Write-state guard and holds

/**
 * Refuses a financial write (503 `ledger_maintenance`) unless the ledger is live. Read inside the write's transaction
 * with the row share-locked, so the state can't flip between this check and the write's commit.
 */
export async function assertLedgerLive(tx: Pick<Database, "select">) {
  const [row] = await tx.select({ state: ledgerState.state }).from(ledgerState).where(eq(ledgerState.id, "ledger")).for("share");
  if (row?.state !== "live") throw new HttpError(503, "ledger_maintenance", MESSAGES.maintenance);
}

/** The held accounts (D4), as `supplierId currency` keys. */
export async function heldAccounts(db: Reader) {
  const rows = await db.select({ supplierId: holds.supplierId, currency: holds.currency }).from(holds);
  return new Set(rows.map((row) => accountKey(row.supplierId, row.currency)));
}

export async function isHeld(db: Reader, supplierId: string, currency: string) {
  const rows = await db
    .select({ supplierId: holds.supplierId })
    .from(holds)
    .where(and(eq(holds.supplierId, supplierId), eq(holds.currency, currency)));
  return rows.length > 0;
}

/** 409 `account_held` (D18): nothing is written to a held account. */
export async function assertNotHeld(db: Reader, supplierId: string, currency: string) {
  if (await isHeld(db, supplierId, currency)) throw conflict("account_held", MESSAGES.held);
}

// ---------------------------------------------------------------------------------------------------------------------
// Posting

/**
 * Serialises every posting to one account until the transaction ends, so balances read before a posting are exact at
 * commit. Taken after any row lock the caller holds; the two-key form never collides with the one-key PO lock.
 */
export async function lockAccount(tx: Pick<Database, "execute">, supplierId: string, currency: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('supplier-ledger'), hashtext(${`${supplierId} ${currency}`}))`);
}

/** The account's balance: the sum of its postings. */
export async function accountBalance(tx: Reader, supplierId: string, currency: string) {
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${e.amount}), 0)`.mapWith(Number) })
    .from(e)
    .where(and(eq(e.supplierId, supplierId), eq(e.currency, currency)));
  return fromCents(cents(row!.total));
}

export type Posting = {
  supplierId: string;
  currency: string;
  entryType: LedgerEntryType;
  amount: number;
  exchangeRate: number | null;
  entryDate: string;
  origin?: LedgerOrigin;
  paymentId?: string | null;
  advanceEntryId?: string | null;
  orderId?: string | null;
  poNumber?: string;
  reversesId?: string | null;
  idempotencyKey: string;
  notes?: string;
  createdBy: string | null;
};

export type PostResult = {
  entry: typeof e.$inferSelect;
  balanceBefore: number;
  balanceAfter: number;
  /** False when the key was already posted: the existing entry is returned and nothing is written. */
  created: boolean;
};

/**
 * The one way the application writes the journal (origin `app`). Refuses a held account, takes the account lock, reads
 * the balance, then inserts the posting unless its idempotency key exists already (then the existing entry comes back,
 * unchanged). Adjustments store the balance before and after.
 */
export async function postLedgerEntry(tx: Tx, posting: Posting): Promise<PostResult> {
  await assertNotHeld(tx, posting.supplierId, posting.currency);
  await lockAccount(tx, posting.supplierId, posting.currency);
  const existing = (await tx.select().from(e).where(eq(e.idempotencyKey, posting.idempotencyKey)))[0];
  const before = await accountBalance(tx, posting.supplierId, posting.currency);
  if (existing) return { entry: existing, balanceBefore: before, balanceAfter: before, created: false };
  const after = fromCents(cents(before) + cents(posting.amount));
  const adjustment = posting.entryType === "adjustment";
  const [entry] = await tx
    .insert(e)
    .values({
      supplierId: posting.supplierId,
      currency: posting.currency,
      entryType: posting.entryType,
      amount: posting.amount,
      exchangeRate: posting.exchangeRate,
      entryDate: posting.entryDate,
      origin: posting.origin ?? "app",
      paymentId: posting.paymentId ?? null,
      advanceEntryId: posting.advanceEntryId ?? null,
      orderId: posting.orderId ?? null,
      poNumber: posting.poNumber ?? "",
      reversesId: posting.reversesId ?? null,
      idempotencyKey: posting.idempotencyKey,
      notes: posting.notes ?? "",
      balanceBefore: adjustment ? before : null,
      balanceAfter: adjustment ? after : null,
      createdBy: posting.createdBy,
    })
    .returning();
  return { entry: entry!, balanceBefore: before, balanceAfter: after, created: true };
}

export type LedgerOrder = { id: string; po: string; supplierId: string; currency: string; exchangeRate: number | null; orderDate: string };

/** The order's value from its lines as they are now (round(Σ quantity × rate, 2)), in cents. */
export async function orderValueCents(tx: Reader, orderId: string) {
  const [row] = await tx
    .select({ total: sql<number>`round(coalesce(sum(${orderLines.quantity} * ${orderLines.rateCny}), 0), 2)`.mapWith(Number) })
    .from(orderLines)
    .where(eq(orderLines.orderId, orderId));
  return cents(row!.total);
}

/** What the journal holds for the order (Σ of its order_* postings, negative), in cents. */
async function postedOrderCents(tx: Reader, orderId: string) {
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${e.amount}), 0)`.mapWith(Number), adjustments: sql<number>`count(*) filter (where ${e.entryType} = 'order_adjustment')`.mapWith(Number) })
    .from(e)
    .where(and(eq(e.orderId, orderId), like(e.entryType, "order_%")));
  return { cents: cents(row!.total), adjustments: row!.adjustments };
}

/** ORD-3: the order's debit, once (key `order:<id>:debit`), at the order's own rate snapshot (NULL kept). */
export async function postOrderDebit(tx: Tx, order: LedgerOrder, userId: string) {
  const value = await orderValueCents(tx, order.id);
  const result = await postLedgerEntry(tx, {
    supplierId: order.supplierId,
    currency: order.currency,
    entryType: "order_debit",
    amount: fromCents(-value),
    exchangeRate: order.exchangeRate,
    entryDate: order.orderDate,
    orderId: order.id,
    poNumber: order.po,
    idempotencyKey: `order:${order.id}:debit`,
    createdBy: userId,
  });
  return { ...result, changeCny: fromCents(-value) };
}

/**
 * ORD-5 after its lines are written: posts the difference between the order's value now and what the journal holds, as
 * one `order_adjustment` (key `order:<id>:adj:<n>`, n counted under the order's row lock the caller holds). Nothing is
 * written when the value is unchanged, so a repeated edit posts nothing.
 */
export async function syncOrderValue(tx: Tx, order: LedgerOrder, userId: string) {
  const value = await orderValueCents(tx, order.id);
  const posted = await postedOrderCents(tx, order.id);
  const delta = -value - posted.cents;
  if (delta === 0) {
    const balance = await accountBalance(tx, order.supplierId, order.currency);
    return { changeCny: 0, balanceBefore: balance, balanceAfter: balance, entry: null };
  }
  const result = await postLedgerEntry(tx, {
    supplierId: order.supplierId,
    currency: order.currency,
    entryType: "order_adjustment",
    amount: fromCents(delta),
    exchangeRate: order.exchangeRate,
    entryDate: todayInIndia(),
    orderId: order.id,
    poNumber: order.po,
    idempotencyKey: `order:${order.id}:adj:${posted.adjustments + 1}`,
    createdBy: userId,
  });
  return { changeCny: fromCents(delta), balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter, entry: result.entry };
}

/** ORD-6 before the delete: gives back everything the journal holds for the order (key `order:<id>:cancel`). */
export async function postOrderCancel(tx: Tx, order: LedgerOrder, userId: string) {
  const posted = await postedOrderCents(tx, order.id);
  const result = await postLedgerEntry(tx, {
    supplierId: order.supplierId,
    currency: order.currency,
    entryType: "order_cancel",
    amount: fromCents(-posted.cents),
    exchangeRate: order.exchangeRate,
    entryDate: todayInIndia(),
    orderId: order.id,
    poNumber: order.po,
    idempotencyKey: `order:${order.id}:cancel`,
    createdBy: userId,
  });
  return { ...result, changeCny: fromCents(-posted.cents) };
}

export type LedgerPayment = { id: string; supplierId: string; currency: string; amount: number; exchangeRate: number | null; paidOn: string };

/** PAY-2: a supplier payment's credit, once (key `payment:<id>`), at the payment's typed rate. */
export function postPaymentCredit(tx: Tx, payment: LedgerPayment, userId: string) {
  return postLedgerEntry(tx, {
    supplierId: payment.supplierId,
    currency: payment.currency,
    entryType: "payment",
    amount: payment.amount,
    exchangeRate: payment.exchangeRate,
    entryDate: payment.paidOn,
    paymentId: payment.id,
    idempotencyKey: `payment:${payment.id}`,
    createdBy: userId,
  });
}

/**
 * PAY-3: reverses the payment's credit (key `payment:<id>:void`), at its rate, dated today. Null when the payment was
 * never posted (a shipping-agent payment, or one still outside the ledger).
 */
export async function postPaymentVoid(tx: Tx, paymentId: string, userId: string, reason: string) {
  const [credit] = await tx
    .select()
    .from(e)
    .where(and(eq(e.paymentId, paymentId), eq(e.entryType, "payment")));
  if (!credit) return null;
  return postLedgerEntry(tx, {
    supplierId: credit.supplierId,
    currency: credit.currency,
    entryType: "payment_void",
    amount: -credit.amount,
    exchangeRate: credit.exchangeRate,
    entryDate: todayInIndia(),
    paymentId,
    reversesId: credit.id,
    idempotencyKey: `payment:${paymentId}:void`,
    notes: reason,
    createdBy: userId,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The FIFO settlement projection (read-only, never stored)

export type PaymentStatus = "unpaid" | "partly" | "paid";

/** One piece of a credit that settles (part of) an order: the landed cost's goods payments and the order's "settled by". */
export type SettlementSlice = {
  entryId: string;
  entryType: "payment" | "adjustment";
  paymentId: string | null;
  advanceEntryId: string | null;
  entryDate: string;
  amount: number;
  exchangeRate: number | null;
  amountInr: number | null;
};

export type OrderSettlement = {
  orderId: string;
  supplierId: string;
  currency: string;
  /** True for an order in a held account (D4): no figures. */
  held: boolean;
  /** True once the journal holds the order's debit; an order outside the ledger has no figures. */
  posted: boolean;
  /** The order's value as the journal holds it (= its lines' value once reconciled). */
  valueCny: number | null;
  settledCny: number | null;
  /** Never negative. */
  outstandingCny: number | null;
  paymentStatus: PaymentStatus | null;
  /** Σ slices' INR at each credit's own rate; null when any slice has no rate. */
  settledInr: number | null;
  slices: SettlementSlice[];
};

export type LedgerAccount = {
  supplierId: string;
  currency: string;
  held: boolean;
  /** Payments − voids ± adjustments (the FIFO pool). Null while held. */
  creditsCny: number | null;
  /** Net order value: debits ± order adjustments − cancels. Null while held. */
  debitsCny: number | null;
  /** Signed: + available with the supplier, 0 settled, − payable to the supplier. Null while held. */
  balanceCny: number | null;
  /** INR of the payments (less their voids) at each payment's own rate; rates not set are left out (`paidInrComplete`). */
  paidInr: number | null;
  paidInrComplete: boolean;
  /** Σ per-order outstanding (never negative) and how many orders still owe. */
  outstandingCny: number | null;
  openOrders: number | null;
  lastPaymentOn: string | null;
  entries: number;
};

type EntryRow = {
  id: string;
  supplierId: string;
  currency: string;
  entryType: LedgerEntryType;
  amount: number;
  exchangeRate: number | null;
  entryDate: string;
  /** created_at at microsecond precision ('YYYY-MM-DD HH24:MI:SS.US', UTC): sorts as text exactly as SQL orders it. */
  createdKey: string;
  paymentId: string | null;
  advanceEntryId: string | null;
  orderId: string | null;
  reversesId: string | null;
};

type OrderRow = { id: string; supplierId: string; currency: string; orderDate: string; createdKey: string };

/** Chronological: business date, then the moment recorded, then id (stable). */
const byText = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
const chronological = (x: { entryDate: string; createdKey: string; id: string }, y: { entryDate: string; createdKey: string; id: string }) =>
  byText(x.entryDate, y.entryDate) || byText(x.createdKey, y.createdKey) || byText(x.id, y.id);

/**
 * The pure projection of one account. Credits (payments, positive adjustments) form lots in chronological order; a void
 * empties its own payment's lot. A negative adjustment takes from the newest lots first (LIFO, owner-approved
 * 2026-11-20): at its own date, from the newest lots that exist then, each lot keeping its rate, so the oldest money
 * keeps settling the oldest orders; any shortfall is carried as a deficit that the next credits fill first. Orders are
 * settled oldest first (order date, then recorded, then id) from the oldest lots. Exported for the unit tests.
 */
export function projectAccount(entries: EntryRow[], orderRows: OrderRow[]) {
  type Lot = { entry: EntryRow; left: number };
  const lots: Lot[] = [];
  const byPayment = new Map<string, Lot>();
  let deficit = 0;
  const addLot = (entry: EntryRow, amount: number) => {
    const fill = Math.min(deficit, amount);
    deficit -= fill;
    const lot = { entry, left: amount - fill };
    lots.push(lot);
    return lot;
  };
  const takeNewest = (amount: number) => {
    let need = amount;
    for (let i = lots.length - 1; i >= 0 && need > 0; i--) {
      const take = Math.min(need, lots[i]!.left);
      lots[i]!.left -= take;
      need -= take;
    }
    deficit += need;
  };

  const credits = entries.filter((row) => row.entryType === "payment" || row.entryType === "payment_void" || row.entryType === "adjustment").sort(chronological);
  // A void always comes right after its own payment when that payment is dated later (a future-dated legacy deposit):
  // it then empties its own lot, never other ones.
  for (let i = 0; i < credits.length; i++) {
    const row = credits[i]!;
    if (row.entryType !== "payment_void" || !row.reversesId) continue;
    const at = credits.findIndex((other) => other.id === row.reversesId);
    if (at > i) {
      credits.splice(i, 1);
      credits.splice(at, 0, row);
      i--;
    }
  }
  for (const entry of credits) {
    const amount = cents(entry.amount);
    if (entry.entryType === "payment") {
      const lot = addLot(entry, amount);
      byPayment.set(entry.id, lot);
    } else if (entry.entryType === "payment_void") {
      const lot = entry.reversesId ? byPayment.get(entry.reversesId) : undefined;
      // A void cancels its own payment; what that lot no longer holds was already taken by a negative adjustment.
      const own = Math.min(-amount, lot?.left ?? 0);
      if (lot) lot.left -= own;
      if (-amount > own) takeNewest(-amount - own);
    } else if (amount > 0) {
      addLot(entry, amount);
    } else {
      takeNewest(-amount);
    }
  }

  // Net value per order (its order_* postings, negated), for the live orders given.
  const posted = new Map<string, { value: number; debit: boolean }>();
  for (const entry of entries) {
    if (!entry.orderId || !entry.entryType.startsWith("order_")) continue;
    const row = posted.get(entry.orderId) ?? { value: 0, debit: false };
    row.value -= cents(entry.amount);
    row.debit ||= entry.entryType === "order_debit";
    posted.set(entry.orderId, row);
  }
  const live = [...orderRows].sort((x, y) => byText(x.orderDate, y.orderDate) || byText(x.createdKey, y.createdKey) || byText(x.id, y.id));
  const settlements = new Map<string, Omit<OrderSettlement, "supplierId" | "currency" | "held">>();
  let lotIndex = 0;
  for (const order of live) {
    const own = posted.get(order.id);
    if (!own?.debit) {
      settlements.set(order.id, { orderId: order.id, posted: false, valueCny: null, settledCny: null, outstandingCny: null, paymentStatus: null, settledInr: null, slices: [] });
      continue;
    }
    const value = Math.max(0, own.value);
    let need = value;
    const slices: SettlementSlice[] = [];
    while (need > 0 && lotIndex < lots.length) {
      const lot = lots[lotIndex]!;
      const take = Math.min(need, lot.left);
      if (take > 0) {
        slices.push({
          entryId: lot.entry.id,
          entryType: lot.entry.entryType === "adjustment" ? "adjustment" : "payment",
          paymentId: lot.entry.paymentId,
          advanceEntryId: lot.entry.advanceEntryId,
          entryDate: lot.entry.entryDate,
          amount: fromCents(take),
          exchangeRate: lot.entry.exchangeRate,
          amountInr: inrOf(take, lot.entry.exchangeRate),
        });
        lot.left -= take;
        need -= take;
      }
      if (lot.left === 0) lotIndex++;
    }
    const settled = value - need;
    const inr = slices.some((slice) => slice.amountInr === null) ? null : fromCents(slices.reduce((sum, slice) => sum + cents(slice.amountInr!), 0));
    settlements.set(order.id, {
      orderId: order.id,
      posted: true,
      valueCny: fromCents(value),
      settledCny: fromCents(settled),
      outstandingCny: fromCents(value - settled),
      paymentStatus: value === 0 || settled === value ? "paid" : settled === 0 ? "unpaid" : "partly",
      settledInr: inr,
      slices,
    });
  }

  const sum = (rows: EntryRow[]) => rows.reduce((total, row) => total + cents(row.amount), 0);
  const paymentRows = entries.filter((row) => row.entryType === "payment" || row.entryType === "payment_void");
  const voided = new Set(entries.filter((row) => row.entryType === "payment_void").map((row) => row.reversesId));
  const lastPaymentOn =
    entries
      .filter((row) => row.entryType === "payment" && !voided.has(row.id))
      .map((row) => row.entryDate)
      .sort()
      .at(-1) ?? null;
  const open = [...settlements.values()].filter((row) => (row.outstandingCny ?? 0) > 0);
  return {
    settlements,
    account: {
      creditsCny: fromCents(sum(credits)),
      debitsCny: fromCents(-sum(entries.filter((row) => row.entryType.startsWith("order_")))),
      balanceCny: fromCents(sum(entries)),
      paidInr: fromCents(paymentRows.reduce((total, row) => total + (row.exchangeRate === null ? 0 : cents(inrOf(cents(row.amount), row.exchangeRate)!)), 0)),
      paidInrComplete: paymentRows.every((row) => row.exchangeRate !== null),
      outstandingCny: fromCents(open.reduce((total, row) => total + cents(row.outstandingCny!), 0)),
      openOrders: open.length,
      lastPaymentOn,
      entries: entries.length,
    },
  };
}

export type Ledger = {
  /** Every account with a posting or a hold, keyed `supplierId currency`. */
  accounts: Map<string, LedgerAccount>;
  /** Every live order in scope, by order id. */
  orders: Map<string, OrderSettlement>;
  /** The supplier's accounts, CNY/USD/INR order left to the caller. */
  accountsOf: (supplierId: string) => LedgerAccount[];
  account: (supplierId: string, currency: string) => LedgerAccount | undefined;
  order: (orderId: string) => OrderSettlement | undefined;
};

const heldAccount = (supplierId: string, currency: string, entries: number): LedgerAccount => ({
  supplierId,
  currency,
  held: true,
  creditsCny: null,
  debitsCny: null,
  balanceCny: null,
  paidInr: null,
  paidInrComplete: false,
  outstandingCny: null,
  openOrders: null,
  lastPaymentOn: null,
  entries,
});

/**
 * Loads the journal and the live orders (of the suppliers given, or all) and projects every account. One query each for
 * entries, orders and holds. ponytail: in memory per supplier (a few hundred rows); a SQL window query when orders reach
 * the thousands.
 */
export async function loadLedger(db: Reader, scope: { supplierIds?: string[] } = {}): Promise<Ledger> {
  const ids = scope.supplierIds;
  if (ids && ids.length === 0) return emptyLedger();
  const ofSuppliers = (column: typeof e.supplierId | typeof orders.supplierId | typeof holds.supplierId): SQL | undefined => (ids ? inArray(column, ids) : undefined);
  // One query after another, never Promise.all: LED-3 and PAY-2 call this inside their transaction, and a transaction is
  // one connection (pg queues concurrent queries on it with a deprecation warning and pg@9 refuses them).
  const entryRows = await db
    .select({
      id: e.id,
      supplierId: e.supplierId,
      currency: e.currency,
      entryType: e.entryType,
      amount: e.amount,
      exchangeRate: e.exchangeRate,
      entryDate: e.entryDate,
      createdKey: sql<string>`to_char(${e.createdAt} at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`,
      paymentId: e.paymentId,
      advanceEntryId: e.advanceEntryId,
      orderId: e.orderId,
      reversesId: e.reversesId,
    })
    .from(e)
    .where(ofSuppliers(e.supplierId))
    .orderBy(asc(e.entryDate), asc(e.createdAt), asc(e.id));
  const orderRowList = await db
    .select({
      id: orders.id,
      supplierId: orders.supplierId,
      currency: orders.currency,
      orderDate: orders.orderDate,
      createdKey: sql<string>`to_char(${orders.createdAt} at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`,
    })
    .from(orders)
    .where(ofSuppliers(orders.supplierId));
  const holdRows = await db.select({ supplierId: holds.supplierId, currency: holds.currency }).from(holds).where(ofSuppliers(holds.supplierId));
  const held = new Set(holdRows.map((row) => accountKey(row.supplierId, row.currency)));
  const keys = new Set([...entryRows.map((row) => accountKey(row.supplierId, row.currency)), ...held]);
  const accounts = new Map<string, LedgerAccount>();
  const settlements = new Map<string, OrderSettlement>();
  for (const key of keys) {
    const [supplierId, currency] = key.split(" ") as [string, string];
    const own = entryRows.filter((row) => row.supplierId === supplierId && row.currency === currency);
    const ownOrders = orderRowList.filter((row) => row.supplierId === supplierId && row.currency === currency);
    if (held.has(key)) {
      accounts.set(key, heldAccount(supplierId, currency, own.length));
      for (const order of ownOrders)
        settlements.set(order.id, { orderId: order.id, supplierId, currency, held: true, posted: false, valueCny: null, settledCny: null, outstandingCny: null, paymentStatus: null, settledInr: null, slices: [] });
      continue;
    }
    const projected = projectAccount(own, ownOrders);
    accounts.set(key, { supplierId, currency, held: false, ...projected.account });
    for (const [id, row] of projected.settlements) settlements.set(id, { ...row, supplierId, currency, held: false });
  }
  // Orders of accounts with no posting at all (outside the ledger until the backfill posts them).
  for (const order of orderRowList) {
    if (!settlements.has(order.id))
      settlements.set(order.id, {
        orderId: order.id,
        supplierId: order.supplierId,
        currency: order.currency,
        held: false,
        posted: false,
        valueCny: null,
        settledCny: null,
        outstandingCny: null,
        paymentStatus: null,
        settledInr: null,
        slices: [],
      });
  }
  return ledgerOf(accounts, settlements);
}

function ledgerOf(accounts: Map<string, LedgerAccount>, settlements: Map<string, OrderSettlement>): Ledger {
  return {
    accounts,
    orders: settlements,
    accountsOf: (supplierId) => [...accounts.values()].filter((row) => row.supplierId === supplierId),
    account: (supplierId, currency) => accounts.get(accountKey(supplierId, currency)),
    order: (orderId) => settlements.get(orderId),
  };
}

const emptyLedger = () => ledgerOf(new Map(), new Map());

export type DepositStatus = "none" | "unmet" | "partly" | "met";

/**
 * The Deposit Required milestone (D11): met once the order's FIFO-settled amount reaches what the supplier asked for.
 * Never a balance of its own; null figures while the order has no settlement (held or outside the ledger).
 */
export function depositMilestone(required: number | null, settlement: OrderSettlement | undefined) {
  const settled = settlement?.settledCny ?? null;
  if (required === null) return { depositRequiredCny: null, depositSettledCny: settled, depositPendingCny: null, depositStatus: "none" as DepositStatus };
  if (settled === null) return { depositRequiredCny: required, depositSettledCny: null, depositPendingCny: null, depositStatus: null };
  const pending = Math.max(0, fromCents(cents(required) - cents(settled)));
  const depositStatus: DepositStatus = cents(settled) >= cents(required) ? "met" : settled <= 0 ? "unmet" : "partly";
  return { depositRequiredCny: required, depositSettledCny: settled, depositPendingCny: pending, depositStatus };
}

/** The settlement figures every order response carries (docs/unified-ledger.md "OrderSettlement fields"). */
export function settlementFields(settlement: OrderSettlement | undefined) {
  return {
    held: settlement?.held ?? false,
    settledCny: settlement?.settledCny ?? null,
    outstandingCny: settlement?.outstandingCny ?? null,
    paymentStatus: settlement?.paymentStatus ?? null,
    settledInr: settlement?.settledInr ?? null,
  };
}

/** The ledger's figures of an account for responses (balances signed; null while held). */
export const accountFields = ({ entries: _entries, ...rest }: LedgerAccount) => rest;

// ---------------------------------------------------------------------------------------------------------------------
// Response helpers shared by the routes

const paymentAuthor = alias(users, "payment_author");
const paymentVoider = alias(users, "payment_voider");

/**
 * The payments matching `where` with what the PaymentRow shape (docs/unified-ledger.md) needs. `where` may use
 * `payments` and the payment's `orders` row (left joined: an orderless payment has none). Voided rows are included;
 * callers order and page it, then map each row with `paymentView`. `recordedBy` is beyond the shape (the order report's
 * timeline names who recorded each payment).
 */
export function paymentQuery(db: Reader, where?: SQL) {
  return db
    .select({
      id: payments.id,
      orderId: payments.orderId,
      po: orders.poNumber,
      supplierId: suppliers.id,
      supplier: suppliers.name,
      /** An orderless payment's own currency; an order-linked one's is its order's. */
      currency: sql<Currency>`coalesce(${payments.currency}, ${orders.currency})`,
      kind: payments.kind,
      payee: payments.payee,
      payeeRole: payments.payeeRole,
      amountCny: payments.amountCny,
      status: payments.status,
      paidOn: payments.paidOn,
      dueDate: payments.dueDate,
      rateInr: payments.rateInr,
      /** INR at the payment's own rate, rounded in SQL as every total is; null while due. */
      amountInr: sql<number | null>`case when ${payments.status} = 'paid' then round(${payments.amountCny} * ${payments.rateInr}, 2) end`.mapWith(Number),
      mode: payments.mode,
      reference: payments.reference,
      notes: payments.notes,
      recordedAt: payments.createdAt,
      recordedBy: sql<string>`coalesce(${paymentAuthor.name}, '')`,
      voidedAt: payments.voidedAt,
      voidedBy: paymentVoider.name,
      voidReason: payments.voidReason,
      /** The payment's account is held (D4): listed as a record, counted in no total. */
      held: sql<boolean>`exists (select 1 from supplier_ledger_holds h
        where h.supplier_id = coalesce(${payments.supplierId}, ${orders.supplierId}) and h.currency = coalesce(${payments.currency}, ${orders.currency}))`,
    })
    .from(payments)
    .leftJoin(orders, eq(orders.id, payments.orderId))
    .innerJoin(suppliers, eq(suppliers.id, sql`coalesce(${payments.supplierId}, ${orders.supplierId})`))
    .leftJoin(paymentAuthor, eq(paymentAuthor.id, payments.createdBy))
    .leftJoin(paymentVoider, eq(paymentVoider.id, payments.voidedBy))
    .where(where)
    .$dynamic();
}
const paymentDay = sql`coalesce(${payments.paidOn}, ${payments.dueDate})`;
/** Latest date first, then the latest recorded (the id last keeps pages stable when one insert wrote several). */
export const newestPaymentsFirst = [desc(paymentDay), desc(payments.createdAt), desc(payments.id)];
export const oldestPaymentsFirst = [asc(paymentDay), asc(payments.createdAt), asc(payments.id)];

/** One row of `paymentQuery` as a PaymentRow (plus `recordedBy`). */
export function paymentView({ recordedAt, voidedAt, voidedBy, ...row }: Awaited<ReturnType<typeof paymentQuery>>[number]) {
  return { ...row, recordedAt: recordedAt.toISOString(), voided: voidedAt !== null, voidedAt: voidedAt?.toISOString() ?? null, voidedBy: voidedAt ? (voidedBy ?? "") : null };
}
export type PaymentRow = Omit<ReturnType<typeof paymentView>, "recordedBy">;
const withoutAuthor = ({ recordedBy: _recordedBy, ...rest }: ReturnType<typeof paymentView>): PaymentRow => rest;
/** paymentView without `recordedBy`: the PaymentRow of the contract, as every list but the order report sends it. */
export const paymentRow = (row: Awaited<ReturnType<typeof paymentQuery>>[number]) => withoutAuthor(paymentView(row));

export type SliceView = SettlementSlice & { mode: string | null; reference: string | null; memoPo: string | null };

/**
 * The SettlementSlice shape with each credit's mode and reference, and the order a legacy payment was recorded against
 * (memo). Reads the payments and receipts behind every slice given in one query each; the returned function maps any
 * of those slices (an adjustment has none of the three).
 */
export async function sliceDetails(db: Reader, slices: SettlementSlice[]) {
  const ids = (pick: (slice: SettlementSlice) => string | null) => [...new Set(slices.flatMap((slice) => (pick(slice) ? [pick(slice)!] : [])))];
  const paymentIds = ids((slice) => slice.paymentId);
  const receiptIds = ids((slice) => slice.advanceEntryId);
  const [paymentList, receiptList] = await Promise.all([
    paymentIds.length
      ? db
          .select({ id: payments.id, mode: payments.mode, reference: payments.reference, memoPo: orders.poNumber })
          .from(payments)
          .leftJoin(orders, eq(orders.id, payments.orderId))
          .where(inArray(payments.id, paymentIds))
      : [],
    receiptIds.length ? db.select({ id: advances.id, mode: advances.mode, reference: advances.reference }).from(advances).where(inArray(advances.id, receiptIds)) : [],
  ]);
  const byPayment = new Map(paymentList.map((row) => [row.id, row]));
  const byReceipt = new Map(receiptList.map((row) => [row.id, row]));
  return (list: SettlementSlice[]): SliceView[] =>
    list.map((slice) => {
      const payment = slice.paymentId ? byPayment.get(slice.paymentId) : undefined;
      const receipt = slice.advanceEntryId ? byReceipt.get(slice.advanceEntryId) : undefined;
      return { ...slice, mode: payment?.mode ?? receipt?.mode ?? null, reference: payment?.reference ?? receipt?.reference ?? null, memoPo: payment?.memoPo ?? null };
    });
}

/** The supplier's accounts for a response: CNY, USD, INR, then the rest by code. */
export const accountsView = (ledger: Ledger, supplierId: string) =>
  ledger
    .accountsOf(supplierId)
    .map(accountFields)
    .sort((x, y) => compareCurrencies(x.currency, y.currency));

/** `[{ currency, balanceCny }]` of the supplier's non-held accounts, CNY/USD/INR first. */
export const balancesOf = (ledger: Ledger, supplierId: string) =>
  accountsView(ledger, supplierId)
    .filter((account) => !account.held)
    .map((account) => ({ currency: account.currency, balanceCny: account.balanceCny! }));
