import { sql } from "drizzle-orm";
import { customType, text, timestamp } from "drizzle-orm/pg-core";

// Shared column helpers and enumerations for the Batch 1 data model. Coordinator-owned.

export const citext = customType<{ data: string }>({ dataType: () => "citext" });

export const ROLES = ["Management", "Procurement", "Accounts", "China staff", "India staff", "Warehouse staff"] as const;
export type Role = (typeof ROLES)[number];
export const STATUSES = ["Active", "Inactive"] as const;
export type RecordStatus = (typeof STATUSES)[number];
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

