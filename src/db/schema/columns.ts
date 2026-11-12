import { sql } from "drizzle-orm";
import { customType, text, timestamp } from "drizzle-orm/pg-core";

// Shared column helpers and enumerations for the Batch 1 data model. Coordinator-owned.

export const citext = customType<{ data: string }>({ dataType: () => "citext" });

export const ROLES = ["Management", "Procurement", "Accounts", "China staff", "India staff", "Warehouse staff"] as const;
export type Role = (typeof ROLES)[number];
export const STATUSES = ["Active", "Inactive"] as const;
export type RecordStatus = (typeof STATUSES)[number];
/** An ISO 4217 code of the currency master (src/currencies): a supplier's, order's or deposit's currency. Stage costs (clearing, transport) are always INR. */
export type Currency = string;
/** The database keeps the shape (three capitals); the API checks the code against the master (docs/supplier-currency.md). */
export const CURRENCY_SHAPE = sql.raw("currency ~ '^[A-Z]{3}$'");
export const LOCATION_TYPES = ["China office", "India office", "Warehouse"] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((value) => `'${value}'`).join(", ")})`);

export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const status = text("status").notNull().default("Active");

