import { sql } from "drizzle-orm";
import { check, integer, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { inList, status, STATUSES, timestamps } from "./columns";

// Migration 0002: the rest of the master data. Coordinator-owned.

const contact = {
  contactPerson: text("contact_person").notNull().default(""),
  phone: text("phone").notNull().default(""),
};

export const shippingAgents = pgTable(
  "shipping_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    ...contact,
    officeCity: text("office_city").notNull().default(""),
    status,
    ...timestamps,
  },
  (t) => [uniqueIndex("shipping_agents_name_unique").on(sql`lower(${t.name})`), check("shipping_agents_status_check", inList("status", STATUSES))],
);

export const clearingAgents = pgTable(
  "clearing_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    ...contact,
    port: text("port").notNull().default(""),
    status,
    ...timestamps,
  },
  (t) => [uniqueIndex("clearing_agents_name_unique").on(sql`lower(${t.name})`), check("clearing_agents_status_check", inList("status", STATUSES))],
);

export const transportCompanies = pgTable(
  "transport_companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    ...contact,
    status,
    ...timestamps,
  },
  (t) => [
    uniqueIndex("transport_companies_name_unique").on(sql`lower(${t.name})`),
    check("transport_companies_status_check", inList("status", STATUSES)),
  ],
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    status,
    ...timestamps,
  },
  (t) => [uniqueIndex("teams_name_unique").on(sql`lower(${t.name})`), check("teams_status_check", inList("status", STATUSES))],
);

/** Units an item is counted in (Settings, Units). `items.counted_in` holds the unit's name and follows a rename. */
export const units = pgTable(
  "units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Unique as typed too: items.counted_in points at it. The lower(name) index below refuses a duplicate in another case.
    name: text("name").notNull().unique("units_name_key"),
    /** Short form shown after quantities ("pcs", "m"); empty shows the name. */
    symbol: text("symbol").notNull().default(""),
    status,
    ...timestamps,
  },
  (t) => [uniqueIndex("units_name_unique").on(sql`lower(${t.name})`), check("units_status_check", inList("status", STATUSES))],
);

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    countedIn: text("counted_in")
      .notNull()
      .references(() => units.name, { onUpdate: "cascade" }),
    /** Default rate per unit on a new order, in the order's currency (0010); null when none is set, never negative. */
    price: numeric("price", { precision: 12, scale: 2, mode: "number" }),
    // Retired by the item-price change (docs/item-price.md): no longer read or written, kept so existing rows lose
    // nothing. A later migration drops them once the release is verified.
    perBundle: integer("per_bundle"),
    bundleLabel: text("bundle_label"),
    status,
    ...timestamps,
  },
  (t) => [
    uniqueIndex("items_name_unique").on(sql`lower(${t.name})`),
    check("items_price_check", sql`price is null or price >= 0`),
    check("items_status_check", inList("status", STATUSES)),
  ],
);
