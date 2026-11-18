import { sql } from "drizzle-orm";
import { type AnyPgColumn, check, date, index, numeric, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { type Currency, CURRENCY_SHAPE, inList, timestamps } from "./columns";
import { suppliers } from "./core";
import { orders, payments } from "./orders";

// Migration 0008 (docs/phase2-contracts.md section 2): supplier-level deposits, money agreed with a supplier outside
// any order. `give`: the company owes the supplier (a deposit to pay); `receive`: the supplier owes the company (a
// deposit to get back). The two directions are never netted. A deposit is settled by its transactions (partial
// settlements allowed); settled, pending and status are summed live, never stored. Nothing here is an order payment:
// order paid/balance, landed cost and the supplier payment reports read `payments` only. Coordinator-owned.

const money = (name: string) => numeric(name, { precision: 14, scale: 2, mode: "number" });

export const DEPOSIT_DIRECTIONS = ["give", "receive"] as const;
export type DepositDirection = (typeof DEPOSIT_DIRECTIONS)[number];

export const supplierDeposits = pgTable(
  "supplier_deposits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    direction: text("direction").$type<DepositDirection>().notNull(),
    /** The agreed amount, in `currency`. */
    amount: money("amount").notNull(),
    currency: text("currency").$type<Currency>().notNull(),
    /** INR per 1 of `currency` when the deposit was opened (0012): the supplier's rate then, 1 for INR; null before 0012 or while the supplier had no rate. */
    exchangeRate: numeric("exchange_rate", { precision: 12, scale: 4, mode: "number" }),
    /** The day the deposit was agreed. */
    openedOn: date("opened_on").notNull(),
    reference: text("reference").notNull().default(""),
    notes: text("notes").notNull().default(""),
    ...timestamps,
    createdBy: uuid("created_by"),
  },
  (t) => [
    index("supplier_deposits_supplier_idx").on(t.supplierId),
    check("supplier_deposits_direction_check", inList("direction", DEPOSIT_DIRECTIONS)),
    check("supplier_deposits_currency_check", CURRENCY_SHAPE),
    check("supplier_deposits_exchange_rate_check", sql`exchange_rate is null or exchange_rate > 0`),
    check("supplier_deposits_amount_check", sql`amount > 0`),
  ],
);

/** One payment (direction give) or receipt (direction receive) against a supplier deposit, in the deposit's currency. */
export const supplierDepositTransactions = pgTable(
  "supplier_deposit_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    depositId: uuid("deposit_id")
      .notNull()
      .references(() => supplierDeposits.id, { onDelete: "cascade" }),
    paidOn: date("paid_on").notNull(),
    amount: money("amount").notNull(),
    mode: text("mode").notNull(),
    reference: text("reference").notNull().default(""),
    notes: text("notes").notNull().default(""),
    ...timestamps,
    createdBy: uuid("created_by"),
  },
  (t) => [index("supplier_deposit_transactions_deposit_idx").on(t.depositId), check("supplier_deposit_transactions_amount_check", sql`amount > 0`)],
);

// Migration 0014 (docs/supplier-advance.md): the supplier advance account, a ledger that is only ever added to.
// `receipt`: money the client paid the supplier before any order (a typed INR rate, like a payment). `allocation`: part
// of one receipt applied to a new order automatically (ORD-3), or when the order's total changes (ORD-5).
// `reversal`: part of one allocation given back to the receipt (ORD-5 lowering the total, ORD-6 deleting the order).
// Available = receipts - allocations + reversals, per supplier and currency; nothing is stored or updated in place.
// An order's advance = its allocations - their reversals. Allocations and reversals keep the rate of the receipt they
// draw from, so the INR of what was applied is the INR that was paid. Not a payment and not a supplier deposit.
/**
 * receipt: advance added before any order. allocation / reversal: part of a lot applied to an order / given back.
 * excess (0016): supplier money paid on an order beyond its value, a lot like a receipt. excess_return (0016): part of
 * an excess taken back (its payment deleted, or the order's value raised). docs/supplier-advance.md.
 */
export const ADVANCE_KINDS = ["receipt", "allocation", "reversal", "excess", "excess_return"] as const;
export type AdvanceKind = (typeof ADVANCE_KINDS)[number];

export const supplierAdvanceEntries = pgTable(
  "supplier_advance_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    kind: text("kind").$type<AdvanceKind>().notNull(),
    amount: money("amount").notNull(),
    currency: text("currency").$type<Currency>().notNull(),
    /** INR per 1 of `currency`: typed on a receipt (1 for INR), copied from the receipt on its allocations and reversals. */
    exchangeRate: numeric("exchange_rate", { precision: 12, scale: 4, mode: "number" }).notNull(),
    /** The lot (receipt or excess) an allocation, reversal or excess return draws from or returns to; null on a lot. */
    advanceId: uuid("advance_id").references((): AnyPgColumn => supplierAdvanceEntries.id),
    /** The allocation a reversal gives back; null otherwise. */
    reversalOf: uuid("reversal_of").references((): AnyPgColumn => supplierAdvanceEntries.id),
    /**
     * The order an allocation or reversal belongs to, or an excess / excess return comes from; null on a receipt and
     * once the order is deleted (ORD-6).
     */
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    /** The order's PO number when written, so the history still names a deleted order; "" on a receipt. */
    poNumber: text("po_number").notNull().default(""),
    /** An excess: the supplier payment it is part of (its date, mode, reference and rate are copied); null once deleted. */
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),
    /** A receipt: the day it was paid. An allocation or reversal: the day it was recorded (India). */
    entryDate: date("entry_date").notNull(),
    mode: text("mode").notNull().default(""),
    reference: text("reference").notNull().default(""),
    notes: text("notes").notNull().default(""),
    ...timestamps,
    createdBy: uuid("created_by"),
  },
  (t) => [
    index("supplier_advance_entries_supplier_idx").on(t.supplierId, t.currency),
    index("supplier_advance_entries_order_idx").on(t.orderId),
    index("supplier_advance_entries_advance_idx").on(t.advanceId),
    index("supplier_advance_entries_reversal_idx").on(t.reversalOf),
    index("supplier_advance_entries_payment_idx").on(t.paymentId),
    check("supplier_advance_entries_kind_check", inList("kind", ADVANCE_KINDS)),
    check("supplier_advance_entries_currency_check", CURRENCY_SHAPE),
    check("supplier_advance_entries_amount_check", sql`amount > 0`),
    check("supplier_advance_entries_exchange_rate_check", sql`exchange_rate > 0 and (currency <> 'INR' or exchange_rate = 1)`),
    check(
      "supplier_advance_entries_shape_check",
      sql`(kind = 'receipt' and advance_id is null and reversal_of is null and order_id is null and po_number = '' and mode <> '' and payment_id is null)
        or (kind = 'allocation' and advance_id is not null and reversal_of is null and po_number <> '' and payment_id is null)
        or (kind = 'reversal' and advance_id is not null and reversal_of is not null and po_number <> '' and payment_id is null)
        or (kind = 'excess' and advance_id is null and reversal_of is null and po_number <> '')
        or (kind = 'excess_return' and advance_id is not null and reversal_of is null and po_number <> '' and payment_id is null)`,
    ),
  ],
);
