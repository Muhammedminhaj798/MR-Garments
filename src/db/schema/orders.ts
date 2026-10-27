import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, numeric, pgTable, primaryKey, smallint, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { inList, timestamps } from "./columns";
import { locations, suppliers } from "./core";
import { items, shippingAgents } from "./master";

// Migration 0003 (approved 2026-10-27): orders and stages 1-3. Orders, Deposits & Payments, the Delivery calendar
// (orders.delivery_date), Receiving in China and Container loading. Coordinator-owned.
// Quantities are whole pieces or metres; money is CNY with 2 decimals; rates are INR per CNY.

const money = (name: string) => numeric(name, { precision: 14, scale: 2, mode: "number" });
const rate = (name: string) => numeric(name, { precision: 12, scale: 4, mode: "number" });

export const PAYMENT_KINDS = ["Deposit", "Balance"] as const;
export const PAYEE_ROLES = ["supplier", "agent"] as const;
export const PAYMENT_STATUSES = ["paid", "due"] as const;
export const TERMS = ["FOB", "CNF"] as const;
export const CONTAINER_STATUSES = ["loading", "sea", "arrived"] as const;

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poNumber: text("po_number").notNull(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    orderDate: date("order_date").notNull(),
    deliveryDate: date("delivery_date").notNull(),
    currency: text("currency").notNull().default("CNY"),
    stage: smallint("stage").notNull().default(1),
    ...timestamps,
    createdBy: uuid("created_by"),
  },
  (t) => [
    uniqueIndex("orders_po_number_unique").on(t.poNumber),
    check("orders_currency_check", sql`currency = 'CNY'`),
    check("orders_stage_check", sql`stage between 1 and 6`),
    check("orders_dates_check", sql`delivery_date >= order_date`),
  ],
);

export const orderLines = pgTable(
  "order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    /** 0 is the order's main line: the item and quantity the lists show. */
    position: smallint("position").notNull(),
    quantity: integer("quantity").notNull(),
    rateCny: rate("rate_cny").notNull(),
  },
  (t) => [
    uniqueIndex("order_lines_position_unique").on(t.orderId, t.position),
    check("order_lines_quantity_check", sql`quantity > 0`),
    check("order_lines_rate_check", sql`rate_cny >= 0`),
  ],
);

/** Recorded payments only: nothing here moves money. */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payee: text("payee").notNull(),
    payeeRole: text("payee_role").notNull(),
    amountCny: money("amount_cny").notNull(),
    status: text("status").notNull(),
    paidOn: date("paid_on"),
    dueDate: date("due_date"),
    rateInr: rate("rate_inr"),
    mode: text("mode"),
    ...timestamps,
    createdBy: uuid("created_by"),
  },
  (t) => [
    index("payments_order_idx").on(t.orderId),
    check("payments_kind_check", inList("kind", PAYMENT_KINDS)),
    check("payments_payee_role_check", inList("payee_role", PAYEE_ROLES)),
    check("payments_status_check", inList("status", PAYMENT_STATUSES)),
    check("payments_amount_check", sql`amount_cny > 0`),
    check(
      "payments_status_fields_check",
      sql`(status = 'paid' and paid_on is not null and rate_inr > 0 and coalesce(mode, '') <> '') or (status = 'due' and due_date is not null)`,
    ),
  ],
);

export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    receivedOn: date("received_on").notNull(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    receivedBy: uuid("received_by").notNull(),
    bundles: integer("bundles").notNull(),
    deliveryNote: text("delivery_note").notNull().default(""),
    shortRemark: text("short_remark").notNull().default(""),
    ...timestamps,
  },
  (t) => [index("receipts_order_idx").on(t.orderId), check("receipts_bundles_check", sql`bundles >= 0`)],
);

export const receiptLines = pgTable(
  "receipt_lines",
  {
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id, { onDelete: "cascade" }),
    orderLineId: uuid("order_line_id")
      .notNull()
      .references(() => orderLines.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
  },
  (t) => [primaryKey({ columns: [t.receiptId, t.orderLineId] }), check("receipt_lines_quantity_check", sql`quantity >= 0`)],
);

export const containers = pgTable(
  "containers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    shippingAgentId: uuid("shipping_agent_id")
      .notNull()
      .references(() => shippingAgents.id),
    terms: text("terms").notNull(),
    portOfLoading: text("port_of_loading").notNull().default(""),
    portOfArrival: text("port_of_arrival").notNull().default(""),
    loadedOn: date("loaded_on"),
    sailedOn: date("sailed_on"),
    eta: date("eta").notNull(),
    etaEstimated: boolean("eta_estimated").notNull().default(false),
    status: text("status").notNull().default("loading"),
    ...timestamps,
    createdBy: uuid("created_by"),
  },
  (t) => [
    uniqueIndex("containers_number_unique").on(sql`upper(${t.number})`),
    check("containers_terms_check", inList("terms", TERMS)),
    check("containers_status_check", inList("status", CONTAINER_STATUSES)),
  ],
);

export const containerLines = pgTable(
  "container_lines",
  {
    containerId: uuid("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
    orderLineId: uuid("order_line_id")
      .notNull()
      .references(() => orderLines.id, { onDelete: "cascade" }),
    bundles: integer("bundles").notNull(),
    quantity: integer("quantity").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.containerId, t.orderLineId] }),
    check("container_lines_bundles_check", sql`bundles >= 0`),
    check("container_lines_quantity_check", sql`quantity > 0`),
  ],
);
