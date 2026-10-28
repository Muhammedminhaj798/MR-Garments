import { sql } from "drizzle-orm";
import { check, date, integer, numeric, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { inList, timestamps } from "./columns";
import { locations } from "./core";
import { clearingAgents, teams, transportCompanies } from "./master";
import { containers, orderLines } from "./orders";

// Migration 0004 (docs/wave3-contracts.md section 1): stages 4-6, Clearing in India, Transport and the India warehouse.
// One clearing and one road trip per container, one warehouse receipt per trip. Coordinator-owned. Money here is INR.

const money = (name: string) => numeric(name, { precision: 14, scale: 2, mode: "number" });
const charge = (name: string) => money(name).notNull().default(0);

export const CLEARING_STATUSES = ["in_clearing", "cleared"] as const;
export const TRANSPORT_STATUSES = ["on_road", "unloaded"] as const;
export const WAREHOUSE_RECEIPT_STATUSES = ["draft", "stocked"] as const;

const authors = {
  createdBy: uuid("created_by").notNull(),
  updatedBy: uuid("updated_by").notNull(),
};

export const clearings = pgTable(
  "clearings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    containerId: uuid("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
    clearingAgentId: uuid("clearing_agent_id")
      .notNull()
      .references(() => clearingAgents.id),
    arrivedOn: date("arrived_on").notNull(),
    handedOn: date("handed_on"),
    billOfEntry: text("bill_of_entry").notNull().default(""),
    dutyPaidOn: date("duty_paid_on"),
    clearedOn: date("cleared_on"),
    /** Information only: not part of the clearing cost. */
    goodsValueInr: money("goods_value_inr"),
    customsDutyInr: charge("customs_duty_inr"),
    otherDutiesInr: charge("other_duties_inr"),
    agentChargesInr: charge("agent_charges_inr"),
    portChargesInr: charge("port_charges_inr"),
    status: text("status").notNull().default("in_clearing"),
    ...timestamps,
    ...authors,
  },
  (t) => [
    uniqueIndex("clearings_container_unique").on(t.containerId),
    check("clearings_status_check", inList("status", CLEARING_STATUSES)),
    check(
      "clearings_charges_check",
      sql`customs_duty_inr >= 0 and other_duties_inr >= 0 and agent_charges_inr >= 0 and port_charges_inr >= 0`,
    ),
    check("clearings_cleared_check", sql`status <> 'cleared' or (cleared_on is not null and duty_paid_on is not null)`),
  ],
);

export const transports = pgTable(
  "transports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    containerId: uuid("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
    transportCompanyId: uuid("transport_company_id")
      .notNull()
      .references(() => transportCompanies.id),
    destinationId: uuid("destination_id")
      .notNull()
      .references(() => locations.id),
    lrNumber: text("lr_number").notNull(),
    vehicleNumber: text("vehicle_number").notNull(),
    driverName: text("driver_name").notNull().default(""),
    driverPhone: text("driver_phone").notNull(),
    bundlesLoaded: integer("bundles_loaded").notNull(),
    loadedOn: date("loaded_on").notNull(),
    loadedFrom: text("loaded_from").notNull().default(""),
    loadedBy: text("loaded_by").notNull().default(""),
    unloadedOn: date("unloaded_on"),
    bundlesReceived: integer("bundles_received"),
    receivedBy: text("received_by").notNull().default(""),
    shortRemark: text("short_remark").notNull().default(""),
    freightInr: charge("freight_inr"),
    /** Loading and unloading. */
    handlingInr: charge("handling_inr"),
    status: text("status").notNull().default("on_road"),
    ...timestamps,
    ...authors,
  },
  (t) => [
    uniqueIndex("transports_container_unique").on(t.containerId),
    check("transports_status_check", inList("status", TRANSPORT_STATUSES)),
    check("transports_bundles_check", sql`bundles_loaded >= 0 and coalesce(bundles_received, 0) >= 0`),
    check("transports_charges_check", sql`freight_inr >= 0 and handling_inr >= 0`),
    check("transports_unloaded_check", sql`status <> 'unloaded' or (unloaded_on is not null and bundles_received is not null)`),
  ],
);

export const warehouseReceipts = pgTable(
  "warehouse_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transportId: uuid("transport_id")
      .notNull()
      .references(() => transports.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    receivedOn: date("received_on").notNull(),
    receivedBy: text("received_by").notNull(),
    bundlesReceived: integer("bundles_received").notNull(),
    status: text("status").notNull().default("draft"),
    ...timestamps,
    ...authors,
  },
  (t) => [
    uniqueIndex("warehouse_receipts_transport_unique").on(t.transportId),
    check("warehouse_receipts_status_check", inList("status", WAREHOUSE_RECEIPT_STATUSES)),
    check("warehouse_receipts_bundles_check", sql`bundles_received >= 0`),
  ],
);

/** The pieces of each order line given to each team. */
export const warehouseReceiptLines = pgTable(
  "warehouse_receipt_lines",
  {
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => warehouseReceipts.id, { onDelete: "cascade" }),
    orderLineId: uuid("order_line_id")
      .notNull()
      .references(() => orderLines.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    quantity: integer("quantity").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.receiptId, t.orderLineId, t.teamId] }),
    check("warehouse_receipt_lines_quantity_check", sql`quantity >= 0`),
  ],
);
