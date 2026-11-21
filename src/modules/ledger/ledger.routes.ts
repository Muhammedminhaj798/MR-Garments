import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { compareCurrencies, currencyCode } from "../../currencies";
import type { Database } from "../../db/client";
import {
  orderLines,
  orders,
  payments,
  supplierAdvanceEntries as advances,
  supplierLedgerEntries as e,
  supplierLedgerHolds as holds,
  suppliers,
  users,
} from "../../db/schema";
import { conflict, notFound, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { money } from "../notifications/notify";
import { isUuid, todayInIndia } from "../stages/common";
import { guardFinalSettlements } from "../costs/landed-cost";
import { DEFAULT_RECEIPT_EXCLUSIONS, reconcileLedger } from "./backfill";
import {
  accountFields,
  assertLedgerLive,
  cents,
  depositMilestone,
  fromCents,
  inrOf,
  isHeld,
  type Ledger,
  loadLedger,
  lockAccount,
  MESSAGES as LEDGER,
  postLedgerEntry,
  settlementFields,
} from "./ledger";

// Owner: the unified supplier ledger (docs/unified-ledger.md). LED-1 GET /suppliers/:supplierId/ledger, LED-2 GET
// /supplier-ledger, LED-3 POST /suppliers/:supplierId/ledger/adjustments, LED-4 GET /supplier-ledger/reconciliation.

export const MESSAGES = {
  amount: "Enter an amount other than 0, with at most 2 decimals.",
  currency: "Choose one of this supplier's currencies.",
  entryDate: "Enter the date of the adjustment.",
  future: "The date can't be in the future.",
  rateInr: "Enter the exchange rate: a number above 0 with at most 4 decimals.",
  rateForInr: "An INR adjustment takes no exchange rate (it is 1).",
  reason: "Enter the reason for the adjustment.",
  reasonTooLong: "Use 1,000 characters or fewer for the reason.",
  idempotencyKey: "Reload the page and try again.",
  idempotencyConflict: "This adjustment was already recorded with different details. Reload the page.",
  /** Owner decision 2026-11-21: an adjustment may not alter the settlement of an order whose landed cost is final. */
  finalSettled: (pos: string[]) =>
    `An adjustment on this date would change the payments that settle ${pos.join(", ")}, whose landed cost is already final. Choose a later date.`,
};
const M = MESSAGES;

const newAdjustment = z.strictObject({
  currency: currencyCode(M.currency),
  /** Signed: + raises the balance (more available with the supplier), − lowers it (more payable). */
  amount: z
    .number({ error: M.amount })
    .min(-999_999_999_999, M.amount)
    .max(999_999_999_999, M.amount)
    .refine((value) => value !== 0 && Number(value.toFixed(2)) === value, M.amount),
  entryDate: z.iso.date({ error: M.entryDate }).refine((day) => day <= todayInIndia(), M.future),
  rateInr: z
    .number({ error: M.rateInr })
    .min(0.0001, M.rateInr)
    .max(99_999_999.9999, M.rateInr)
    .refine((value) => Number(value.toFixed(4)) === value, M.rateInr)
    .optional(),
  reason: z.string({ error: M.reason }).trim().min(1, M.reason).max(1000, M.reasonTooLong),
  idempotencyKey: z.uuid({ error: M.idempotencyKey }),
});

/**
 * The currencies a payment or adjustment may use for the supplier (D10): its current currency plus any currency with a
 * non-zero balance, never a held one, CNY/USD/INR first.
 */
export function currencyOptions(supplier: { id: string; currency: string }, ledger: Ledger) {
  const accounts = ledger.accountsOf(supplier.id);
  const heldCurrencies = new Set(accounts.filter((row) => row.held).map((row) => row.currency));
  const open = accounts.filter((row) => !row.held && (row.balanceCny ?? 0) !== 0).map((row) => row.currency);
  return [...new Set([supplier.currency, ...open])].filter((currency) => !heldCurrencies.has(currency)).sort(compareCurrencies);
}

const orderOfEntry = alias(orders, "entry_order");
const memoOrder = alias(orders, "memo_order");
const author = alias(users, "author");
const voider = alias(users, "voider");

/** One supplier's postings with their documents, oldest first (business date, then recorded, then id). */
function statementRows(db: Pick<Database, "select">, supplierId: string) {
  return db
    .select({
      id: e.id,
      entryType: e.entryType,
      currency: e.currency,
      amount: e.amount,
      exchangeRate: e.exchangeRate,
      entryDate: e.entryDate,
      origin: e.origin,
      orderId: e.orderId,
      /** The order's PO as it is now; a deleted order's as it was when posted. */
      po: sql<string>`coalesce(${orderOfEntry.poNumber}, nullif(${e.poNumber}, ''))`,
      paymentId: e.paymentId,
      advanceEntryId: e.advanceEntryId,
      reversesId: e.reversesId,
      notes: e.notes,
      balanceBefore: e.balanceBefore,
      balanceAfter: e.balanceAfter,
      recordedAt: e.createdAt,
      recordedBy: sql<string>`coalesce(${author.name}, '')`,
      payment: {
        kind: payments.kind,
        payeeRole: payments.payeeRole,
        mode: payments.mode,
        reference: payments.reference,
        notes: payments.notes,
        /** A payment from before 0017 keeps the order it was recorded against, as a memo. */
        memoPo: memoOrder.poNumber,
        voidedAt: payments.voidedAt,
        voidedBy: sql<string | null>`${voider.name}`,
        voidReason: payments.voidReason,
      },
      advance: { mode: advances.mode, reference: advances.reference, notes: advances.notes },
    })
    .from(e)
    .leftJoin(orderOfEntry, eq(orderOfEntry.id, e.orderId))
    .leftJoin(payments, eq(payments.id, e.paymentId))
    .leftJoin(memoOrder, eq(memoOrder.id, payments.orderId))
    .leftJoin(voider, eq(voider.id, payments.voidedBy))
    .leftJoin(advances, eq(advances.id, e.advanceEntryId))
    .leftJoin(author, eq(author.id, e.createdBy))
    .where(eq(e.supplierId, supplierId))
    .orderBy(asc(e.entryDate), asc(e.createdAt), asc(e.id));
}
type StatementRow = Awaited<ReturnType<typeof statementRows>>[number];

/** The LedgerEntry shape (docs/unified-ledger.md). `runningBalance` is the account's balance right after the entry. */
export function entryView(row: StatementRow, runningBalance: number | null) {
  const { payment, advance, ...rest } = row;
  return {
    ...rest,
    amountInr: inrOf(cents(row.amount), row.exchangeRate),
    runningBalance,
    recordedAt: row.recordedAt.toISOString(),
    payment: row.paymentId
      ? { ...payment, voidedAt: payment.voidedAt ? payment.voidedAt.toISOString() : null, voided: payment.voidedAt !== null }
      : null,
    advance: row.advanceEntryId ? advance : null,
  };
}
export type LedgerEntryView = ReturnType<typeof entryView>;

/** Every entry of the supplier, newest first, with the running balance of its currency (chronological). */
export async function supplierStatement(db: Pick<Database, "select">, supplierId: string) {
  const rows = await statementRows(db, supplierId);
  const running = new Map<string, number>();
  const views = rows.map((row) => {
    const balance = (running.get(row.currency) ?? 0) + cents(row.amount);
    running.set(row.currency, balance);
    return entryView(row, fromCents(balance));
  });
  return views.toReversed();
}

/** The raw legacy records of a held account (D4), read-only: nothing here is posted or counted. */
async function heldRecords(db: Pick<Database, "select">, supplierId: string, currency: string, reason: string) {
  const [orderRows, paymentRows, receiptRows] = await Promise.all([
    db
      .select({
        id: orders.id,
        po: orders.poNumber,
        orderDate: orders.orderDate,
        stage: orders.stage,
        valueCny: sql<number>`round(coalesce(sum(${orderLines.quantity} * ${orderLines.rateCny}), 0), 2)`.mapWith(Number),
      })
      .from(orders)
      .leftJoin(orderLines, eq(orderLines.orderId, orders.id))
      .where(and(eq(orders.supplierId, supplierId), eq(orders.currency, currency)))
      .groupBy(orders.id)
      .orderBy(asc(orders.orderDate), asc(orders.createdAt)),
    db
      .select({
        id: payments.id,
        po: orders.poNumber,
        kind: payments.kind,
        payeeRole: payments.payeeRole,
        status: payments.status,
        amountCny: payments.amountCny,
        paidOn: payments.paidOn,
        rateInr: payments.rateInr,
        mode: payments.mode,
        reference: payments.reference,
        notes: payments.notes,
        recordedAt: payments.createdAt,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(and(eq(orders.supplierId, supplierId), eq(orders.currency, currency)))
      .orderBy(asc(payments.paidOn), asc(payments.createdAt)),
    db
      .select({
        id: advances.id,
        kind: advances.kind,
        amount: advances.amount,
        entryDate: advances.entryDate,
        exchangeRate: advances.exchangeRate,
        po: advances.poNumber,
        mode: advances.mode,
        reference: advances.reference,
        notes: advances.notes,
        recordedAt: advances.createdAt,
      })
      .from(advances)
      .where(and(eq(advances.supplierId, supplierId), eq(advances.currency, currency)))
      .orderBy(asc(advances.entryDate), asc(advances.createdAt)),
  ]);
  return { currency, reason, orders: orderRows, payments: paymentRows, advanceEntries: receiptRows };
}

/**
 * LED-2's body (PAY-1 sends its accounts and totals too): every account of the ledger given with its supplier, by name
 * then currency, and per-currency totals that leave held accounts out.
 */
export async function ledgerOverview(db: Pick<Database, "select">, ledger: Ledger) {
  const supplierRows = await db
    .select({ id: suppliers.id, code: suppliers.code, name: suppliers.name, status: suppliers.status, currency: suppliers.currency })
    .from(suppliers)
    .orderBy(sql`lower(${suppliers.name})`);
  const byId = new Map(supplierRows.map((row) => [row.id, row]));
  const accounts = [...ledger.accounts.values()]
    .map((account) => {
      const supplier = byId.get(account.supplierId)!;
      return { ...accountFields(account), supplier: supplier.name, code: supplier.code, status: supplier.status };
    })
    .sort((x, y) => x.supplier.toLowerCase().localeCompare(y.supplier.toLowerCase()) || compareCurrencies(x.currency, y.currency));
  const currencies = [...new Set(accounts.filter((row) => !row.held).map((row) => row.currency))].sort(compareCurrencies);
  const totals = currencies.map((currency) => {
    const own = accounts.filter((row) => !row.held && row.currency === currency);
    const sumOf = (pick: (row: (typeof own)[number]) => number) => fromCents(own.reduce((total, row) => total + cents(pick(row)), 0));
    return {
      currency,
      accounts: own.length,
      balanceCny: sumOf((row) => row.balanceCny!),
      /** Σ of the negative balances, as a positive amount: what the business owes suppliers in this currency. */
      payableCny: sumOf((row) => Math.max(0, -row.balanceCny!)),
      /** Σ of the positive balances: money available with suppliers. */
      availableCny: sumOf((row) => Math.max(0, row.balanceCny!)),
      outstandingCny: sumOf((row) => row.outstandingCny!),
    };
  });
  return { accounts, totals, suppliers: supplierRows.map(({ id, name, status }) => ({ id, name, status })) };
}

export function ledgerRoutes({ db }: RouteContext) {
  const router = Router();

  async function supplierOf(id: string) {
    if (!isUuid(id)) throw notFound("Supplier");
    const [supplier] = await db
      .select({ id: suppliers.id, code: suppliers.code, name: suppliers.name, currency: suppliers.currency, exchangeRate: suppliers.exchangeRate, status: suppliers.status })
      .from(suppliers)
      .where(eq(suppliers.id, id));
    if (!supplier) throw notFound("Supplier");
    return supplier;
  }

  // LED-1. One supplier's ledger: its accounts (one per currency, held ones without figures), every entry newest first
  // with the running balance, the FIFO projection of its live orders (oldest first) and the held accounts' raw records.
  router.get("/suppliers/:supplierId/ledger", requirePermission("payments", "View"), async (req, res) => {
    const supplier = await supplierOf(String(req.params.supplierId));
    const [ledger, entries, orderRows, holdRows] = await Promise.all([
      loadLedger(db, { supplierIds: [supplier.id] }),
      supplierStatement(db, supplier.id),
      db
        .select({
          id: orders.id,
          po: orders.poNumber,
          orderDate: orders.orderDate,
          stage: orders.stage,
          currency: orders.currency,
          exchangeRate: orders.exchangeRate,
          depositRequiredCny: orders.depositRequiredCny,
          // Joined and grouped: in a single-table select drizzle would drop the table name from a correlated orders.id.
          valueCny: sql<number>`round(coalesce(sum(${orderLines.quantity} * ${orderLines.rateCny}), 0), 2)`.mapWith(Number),
        })
        .from(orders)
        .leftJoin(orderLines, eq(orderLines.orderId, orders.id))
        .where(eq(orders.supplierId, supplier.id))
        .groupBy(orders.id)
        .orderBy(asc(orders.orderDate), asc(orders.createdAt), asc(orders.id)),
      db.select({ currency: holds.currency, reason: holds.reason }).from(holds).where(eq(holds.supplierId, supplier.id)),
    ]);
    res.json({
      supplier,
      accounts: ledger
        .accountsOf(supplier.id)
        .map(accountFields)
        .sort((x, y) => compareCurrencies(x.currency, y.currency)),
      currencyOptions: currencyOptions(supplier, ledger),
      entries,
      orders: orderRows.map((row) => {
        const settlement = ledger.order(row.id);
        return { ...row, ...settlementFields(settlement), ...depositMilestone(row.depositRequiredCny, settlement) };
      }),
      held: await Promise.all(holdRows.sort((x, y) => compareCurrencies(x.currency, y.currency)).map((row) => heldRecords(db, supplier.id, row.currency, row.reason))),
    });
  });

  // LED-2. Every supplier account (supplier name, then currency) and per-currency totals that leave held accounts out.
  router.get("/supplier-ledger", requirePermission("payments", "View"), async (_req, res) => {
    res.json(await ledgerOverview(db, await loadLedger(db)));
  });

  // LED-3. Management only (payments Full): a signed correction of one account, with a reason, in one transaction under
  // the account lock. The client's idempotency key makes a resubmit return the same entry; the same key with other
  // details is 409. The actor and the timestamp are the session's and the server's (the body can't carry them). Refused
  // (422 entryDate, nothing written) when it would change the settlement of an order whose landed cost is final.
  router.post("/suppliers/:supplierId/ledger/adjustments", requirePermission("payments", "Full"), async (req, res) => {
    const supplierId = String(req.params.supplierId);
    if (!isUuid(supplierId)) throw notFound("Supplier");
    const input = parse(newAdjustment, req.body);
    const key = `adjustment:${input.idempotencyKey}`;
    const result = await db.transaction(async (tx) => {
      await assertLedgerLive(tx);
      // One request per key at a time, and a key already posted replays before any check that may have changed since
      // (e.g. the currency left the options once this adjustment cleared its balance): same details 200, else 409.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ledger.adjustment'), hashtext(${key}))`);
      const [known] = await tx.select().from(e).where(eq(e.idempotencyKey, key));
      if (known) {
        const rate = input.currency === "INR" ? 1 : (input.rateInr ?? null);
        const same =
          known.supplierId === supplierId &&
          known.currency === input.currency &&
          cents(known.amount) === cents(input.amount) &&
          known.entryDate === input.entryDate &&
          known.exchangeRate === rate &&
          known.notes === input.reason;
        if (!same) throw conflict("idempotency_conflict", M.idempotencyConflict);
        return { entry: known, balanceBefore: known.balanceBefore!, balanceAfter: known.balanceAfter!, created: false, supplier: "" };
      }
      const [supplier] = await tx.select({ id: suppliers.id, currency: suppliers.currency, name: suppliers.name }).from(suppliers).where(eq(suppliers.id, supplierId)).for("share");
      if (!supplier) throw notFound("Supplier");
      if (await isHeld(tx, supplierId, input.currency)) throw conflict("account_held", LEDGER.held);
      const options = currencyOptions(supplier, await loadLedger(tx, { supplierIds: [supplierId] }));
      const problems: Record<string, string> = {};
      if (!options.includes(input.currency)) problems.currency = M.currency;
      if (input.currency === "INR" && input.rateInr !== undefined && input.rateInr !== 1) problems.rateInr = M.rateForInr;
      if (input.currency !== "INR" && input.rateInr === undefined) problems.rateInr = M.rateInr;
      if (Object.keys(problems).length > 0) throw validationFailed(problems);
      const rate = input.currency === "INR" ? 1 : input.rateInr!;
      // A backdated adjustment counts from its own date and may change later orders' settlement, but never that of an
      // order whose landed cost is final: with the account locked, those settlements before and after (422 entryDate).
      await lockAccount(tx, supplierId, input.currency);
      const finalChanged = await guardFinalSettlements(tx, supplierId, input.currency);
      const posted = await postLedgerEntry(tx, {
        supplierId,
        currency: input.currency,
        entryType: "adjustment",
        amount: input.amount,
        exchangeRate: rate,
        entryDate: input.entryDate,
        idempotencyKey: key,
        notes: input.reason,
        createdBy: req.user!.id,
      });
      const altered = posted.created ? await finalChanged() : [];
      if (altered.length > 0) throw validationFailed({ entryDate: M.finalSettled(altered) });
      if (!posted.created) {
        const same =
          posted.entry.supplierId === supplierId &&
          posted.entry.currency === input.currency &&
          cents(posted.entry.amount) === cents(input.amount) &&
          posted.entry.entryDate === input.entryDate &&
          posted.entry.exchangeRate === rate &&
          posted.entry.notes === input.reason;
        if (!same) throw conflict("idempotency_conflict", M.idempotencyConflict);
      }
      return { ...posted, supplier: supplier.name };
    });
    const [row] = (await statementRows(db, supplierId)).filter((entry) => entry.id === result.entry.id);
    if (result.created)
      console.info(`Ledger adjustment ${result.entry.id} (${money(input.amount, input.currency)} for ${result.supplier}) by user ${req.user!.id}: ${input.reason}`);
    // The balances before and after are the account's at the moment it was recorded (an adjustment may be dated
    // earlier); the statement (LED-1) shows the running balance in date order.
    res.status(result.created ? 201 : 200).json({
      entry: entryView(row!, null),
      balanceBefore: result.entry.balanceBefore,
      balanceAfter: result.entry.balanceAfter,
    });
  });

  // LED-4. admin Full: the reconciliation invariants (plan 4.6), read-only. The release script is the same function.
  router.get("/supplier-ledger/reconciliation", requirePermission("admin", "Full"), async (_req, res) => {
    // The owner's excluded receipts are never credited; without the list they would read as missing credits forever.
    res.json(await reconcileLedger(db, [], DEFAULT_RECEIPT_EXCLUSIONS));
  });

  return router;
}
