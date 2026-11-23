import { sql } from "drizzle-orm";
import { type AnyPgColumn, check, date, index, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { type Currency, CURRENCY_SHAPE, inList } from "./columns";
import { suppliers } from "./core";
import { supplierAdvanceEntries } from "./deposits";
import { orders, payments } from "./orders";

// Migration 0017 (docs/unified-ledger.md): the unified supplier ledger. One append-only journal per supplier and
// currency is the only source of a supplier's balance: + money with the supplier, − owed to the supplier. Documents stay
// where they are (payments, orders, the archived advance receipts); every posting links to exactly one of them and has a
// unique idempotency key, so no event is ever posted twice. A trigger refuses UPDATE and DELETE (only the orders FK may
// set order_id to null when ORD-6 deletes a cancelled order). Coordinator-owned.

const money = (name: string) => numeric(name, { precision: 14, scale: 2, mode: "number" });

export const LEDGER_ENTRY_TYPES = ["payment", "payment_void", "order_debit", "order_adjustment", "order_cancel", "adjustment"] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];
/** Who wrote a posting: the backfill script (history) or the application (after cutover). The rollback check reads it. */
export const LEDGER_ORIGINS = ["backfill", "app"] as const;
export type LedgerOrigin = (typeof LEDGER_ORIGINS)[number];

export const supplierLedgerEntries = pgTable(
  "supplier_ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    currency: text("currency").$type<Currency>().notNull(),
    entryType: text("entry_type").$type<LedgerEntryType>().notNull(),
    /** Signed: + money with the supplier (payments, cancels, raising adjustments), − owed (debits, voids, lowering adjustments). */
    amount: money("amount").notNull(),
    /** INR per 1 unit at the event, copied from the source as it is (NULL kept: never invented); 1 for INR when set. */
    exchangeRate: numeric("exchange_rate", { precision: 12, scale: 4, mode: "number" }),
    /** The business date: paid on, order date, or the day recorded. */
    entryDate: date("entry_date").notNull(),
    origin: text("origin").$type<LedgerOrigin>().notNull(),
    /** Management adjustments only: the account balance just before and after, under the account lock. */
    balanceBefore: money("balance_before"),
    balanceAfter: money("balance_after"),
    paymentId: uuid("payment_id").references(() => payments.id),
    /** A legacy advance receipt (0014) posted as a credit; never an allocation, reversal or excess row. */
    advanceEntryId: uuid("advance_entry_id").references(() => supplierAdvanceEntries.id),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    /** The PO number when written: renames and deletes keep the history readable. */
    poNumber: text("po_number").notNull().default(""),
    /** A payment void: the payment posting it reverses. */
    reversesId: uuid("reverses_id").references((): AnyPgColumn => supplierLedgerEntries.id),
    idempotencyKey: text("idempotency_key").notNull(),
    /** A Management adjustment's reason; otherwise free text. */
    notes: text("notes").notNull().default(""),
    /** clock_timestamp(), not now(): postings of one transaction keep the order they were written in. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    createdBy: uuid("created_by"),
  },
  (t) => [
    uniqueIndex("supplier_ledger_entries_idempotency_unique").on(t.idempotencyKey),
    uniqueIndex("supplier_ledger_entries_one_void_unique").on(t.reversesId).where(sql`entry_type = 'payment_void'`),
    index("supplier_ledger_entries_account_idx").on(t.supplierId, t.currency, t.entryDate, t.createdAt),
    index("supplier_ledger_entries_order_idx").on(t.orderId),
    index("supplier_ledger_entries_payment_idx").on(t.paymentId),
    index("supplier_ledger_entries_advance_idx").on(t.advanceEntryId),
    check("supplier_ledger_entries_type_check", inList("entry_type", LEDGER_ENTRY_TYPES)),
    check("supplier_ledger_entries_origin_check", inList("origin", LEDGER_ORIGINS)),
    check("supplier_ledger_entries_currency_check", CURRENCY_SHAPE),
    check(
      "supplier_ledger_entries_sign_check",
      sql`(entry_type = 'payment' and amount > 0) or (entry_type = 'payment_void' and amount < 0)
        or (entry_type = 'order_debit' and amount <= 0) or (entry_type = 'order_cancel' and amount >= 0)
        or (entry_type in ('order_adjustment', 'adjustment') and amount <> 0)`,
    ),
    check(
      "supplier_ledger_entries_shape_check",
      sql`(entry_type = 'payment' and num_nonnulls(payment_id, advance_entry_id) = 1 and order_id is null and reverses_id is null)
        or (entry_type = 'payment_void' and num_nonnulls(payment_id, advance_entry_id) = 1 and order_id is null and reverses_id is not null)
        or (entry_type in ('order_debit', 'order_adjustment', 'order_cancel') and payment_id is null and advance_entry_id is null and reverses_id is null and po_number <> '')
        or (entry_type = 'adjustment' and payment_id is null and advance_entry_id is null and order_id is null and reverses_id is null
            and origin = 'app' and btrim(notes) <> '' and exchange_rate is not null and created_by is not null
            and balance_before is not null and balance_after = balance_before + amount)`,
    ),
    check("supplier_ledger_entries_balances_check", sql`(entry_type = 'adjustment') = (balance_before is not null and balance_after is not null)`),
    check("supplier_ledger_entries_rate_check", sql`exchange_rate is null or (exchange_rate > 0 and (currency <> 'INR' or exchange_rate = 1))`),
  ],
);

/**
 * Accounts held out of the ledger (owner decision D4): nothing is posted to them, they count in no total or projection,
 * and new orders, payments and adjustments for them are refused (D18) until a separately approved resolution. Written
 * by the backfill script's explicit list (SUP-010 CNY); never removed by the application.
 */
export const supplierLedgerHolds = pgTable(
  "supplier_ledger_holds",
  {
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    currency: text("currency").$type<Currency>().notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.supplierId, t.currency] }), check("supplier_ledger_holds_currency_check", CURRENCY_SHAPE)],
);

export const LEDGER_STATES = ["maintenance", "live"] as const;
export type LedgerStateValue = (typeof LEDGER_STATES)[number];

/**
 * The write-state guard (docs/unified-ledger.md): one row. While `maintenance`, every financial write answers 503; only
 * the reconciliation script (`scripts/ledger-reconcile.ts --open`) sets `live`, and only when every invariant passes.
 */
export const ledgerState = pgTable(
  "ledger_state",
  {
    id: text("id").primaryKey().default("ledger"),
    state: text("state").$type<LedgerStateValue>().notNull().default("maintenance"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Who changed it: the operator's note (scripts run without a signed-in user). */
    note: text("note").notNull().default(""),
  },
  () => [check("ledger_state_single_row_check", sql`id = 'ledger'`), check("ledger_state_state_check", inList("state", LEDGER_STATES))],
);

/**
 * Migration 0018 (owner review of 2026-11-23, docs/unified-ledger.md "Final landed-cost protection"): an order that has
 * reached final landed cost stays protected, even after a Management-approved receipt, receipt delete or rate correction
 * changes its settlement (it may then no longer be final). Written by the M8 guard (costs/landed-cost.ts
 * guardFinalSettlements) for every order it sees final; never updated or deleted (trigger).
 */
export const finalCostProtections = pgTable(
  "final_cost_protections",
  {
    orderId: uuid("order_id")
      .primaryKey()
      .references(() => orders.id, { onDelete: "restrict" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    currency: text("currency").$type<Currency>().notNull(),
    /** When the guard first saw the order's landed cost final. */
    protectedAt: timestamp("protected_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [index("final_cost_protections_account_idx").on(t.supplierId, t.currency), check("final_cost_protections_currency_check", CURRENCY_SHAPE)],
);
