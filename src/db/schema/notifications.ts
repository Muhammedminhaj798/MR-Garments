import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { inList } from "./columns";
import { users } from "./core";

// Migration 0005: in-app notifications (D:\SDEC\MR Garments\docs\notifications-contract.md). Coordinator-owned.
// Rows are written only inside the business transaction that causes them (src/modules/notifications/notify.ts).

export const NOTIFICATION_KINDS = ["short-receipt", "payment-recorded", "container-loaded", "container-sailed", "container-arrived"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    details: text("details").array().notNull(),
    href: text("href"),
    /** `<kind>:<source record id>`, unique per user, so a replayed event adds nothing. */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("notifications_dedupe_unique").on(t.userId, t.dedupeKey),
    index("notifications_list_idx").on(t.userId, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
    index("notifications_unread_idx").on(t.userId).where(sql`read_at is null`),
    check("notifications_kind_check", inList("kind", NOTIFICATION_KINDS)),
  ],
);
