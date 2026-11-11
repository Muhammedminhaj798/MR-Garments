import { sql } from "drizzle-orm";
import { check, date, index, numeric, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { type Currency, CURRENCIES, inList, timestamps } from "./columns";
import { suppliers } from "./core";

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
    check("supplier_deposits_currency_check", inList("currency", CURRENCIES)),
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
