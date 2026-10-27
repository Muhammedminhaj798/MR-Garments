import { sql } from "drizzle-orm";
import { check, index, json, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

import { citext, inList, LOCATION_TYPES, ROLES, status, STATUSES, timestamps } from "./columns";

// Migration 0001: sign-in, users and suppliers. Coordinator-owned.

export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    country: text("country").notNull(),
    address: text("address").notNull().default(""),
    status,
    ...timestamps,
  },
  (t) => [
    uniqueIndex("locations_name_unique").on(sql`lower(${t.name})`),
    check("locations_type_check", inList("type", LOCATION_TYPES)),
    check("locations_country_check", inList("country", ["China", "India"])),
    check("locations_status_check", inList("status", STATUSES)),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: citext("email").notNull(),
    phone: text("phone").notNull().default(""),
    role: text("role").notNull(),
    locationId: uuid("location_id").references(() => locations.id),
    language: text("language").notNull().default("English"),
    passwordHash: text("password_hash"),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
    status,
    ...timestamps,
    createdBy: uuid("created_by"),
    updatedBy: uuid("updated_by"),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email),
    check("users_role_check", inList("role", ROLES)),
    check("users_status_check", inList("status", STATUSES)),
  ],
);

export const userStageGrants = pgTable(
  "user_stage_grants",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stage: smallint("stage").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.stage] }), check("user_stage_grants_stage_check", sql`stage between 2 and 6`)],
);

export const passwordTokens = pgTable(
  "password_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("password_tokens_user_idx").on(t.userId), check("password_tokens_purpose_check", inList("purpose", ["reset", "invite"]))],
);

/** connect-pg-simple's table layout. */
export const session = pgTable(
  "session",
  {
    sid: varchar("sid").primaryKey(),
    sess: json("sess").notNull(),
    expire: timestamp("expire", { precision: 6 }).notNull(),
  },
  (t) => [index("IDX_session_expire").on(t.expire)],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    contactPerson: text("contact_person").notNull().default(""),
    phone: text("phone").notNull().default(""),
    city: text("city").notNull().default(""),
    address: text("address").notNull().default(""),
    notes: text("notes").notNull().default(""),
    currency: text("currency").notNull().default("CNY"),
    status,
    ...timestamps,
    createdBy: uuid("created_by"),
  },
  (t) => [
    uniqueIndex("suppliers_name_unique").on(sql`lower(${t.name})`),
    check("suppliers_currency_check", sql`currency = 'CNY'`),
    check("suppliers_status_check", inList("status", STATUSES)),
  ],
);

