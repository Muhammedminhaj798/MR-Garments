CREATE TABLE "clearings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"container_id" uuid NOT NULL,
	"clearing_agent_id" uuid NOT NULL,
	"arrived_on" date NOT NULL,
	"handed_on" date,
	"bill_of_entry" text DEFAULT '' NOT NULL,
	"duty_paid_on" date,
	"cleared_on" date,
	"goods_value_inr" numeric(14, 2),
	"customs_duty_inr" numeric(14, 2) DEFAULT 0 NOT NULL,
	"other_duties_inr" numeric(14, 2) DEFAULT 0 NOT NULL,
	"agent_charges_inr" numeric(14, 2) DEFAULT 0 NOT NULL,
	"port_charges_inr" numeric(14, 2) DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'in_clearing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "clearings_status_check" CHECK (status in ('in_clearing', 'cleared')),
	CONSTRAINT "clearings_charges_check" CHECK (customs_duty_inr >= 0 and other_duties_inr >= 0 and agent_charges_inr >= 0 and port_charges_inr >= 0),
	CONSTRAINT "clearings_cleared_check" CHECK (status <> 'cleared' or (cleared_on is not null and duty_paid_on is not null))
);
--> statement-breakpoint
CREATE TABLE "transports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"container_id" uuid NOT NULL,
	"transport_company_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"lr_number" text NOT NULL,
	"vehicle_number" text NOT NULL,
	"driver_name" text DEFAULT '' NOT NULL,
	"driver_phone" text NOT NULL,
	"bundles_loaded" integer NOT NULL,
	"loaded_on" date NOT NULL,
	"loaded_from" text DEFAULT '' NOT NULL,
	"loaded_by" text DEFAULT '' NOT NULL,
	"unloaded_on" date,
	"bundles_received" integer,
	"received_by" text DEFAULT '' NOT NULL,
	"short_remark" text DEFAULT '' NOT NULL,
	"freight_inr" numeric(14, 2) DEFAULT 0 NOT NULL,
	"handling_inr" numeric(14, 2) DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'on_road' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "transports_status_check" CHECK (status in ('on_road', 'unloaded')),
	CONSTRAINT "transports_bundles_check" CHECK (bundles_loaded >= 0 and coalesce(bundles_received, 0) >= 0),
	CONSTRAINT "transports_charges_check" CHECK (freight_inr >= 0 and handling_inr >= 0),
	CONSTRAINT "transports_unloaded_check" CHECK (status <> 'unloaded' or (unloaded_on is not null and bundles_received is not null))
);
--> statement-breakpoint
CREATE TABLE "warehouse_receipt_lines" (
	"receipt_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "warehouse_receipt_lines_receipt_id_order_line_id_team_id_pk" PRIMARY KEY("receipt_id","order_line_id","team_id"),
	CONSTRAINT "warehouse_receipt_lines_quantity_check" CHECK (quantity >= 0)
);
--> statement-breakpoint
CREATE TABLE "warehouse_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transport_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"received_on" date NOT NULL,
	"received_by" text NOT NULL,
	"bundles_received" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "warehouse_receipts_status_check" CHECK (status in ('draft', 'stocked')),
	CONSTRAINT "warehouse_receipts_bundles_check" CHECK (bundles_received >= 0)
);
--> statement-breakpoint
ALTER TABLE "clearings" ADD CONSTRAINT "clearings_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clearings" ADD CONSTRAINT "clearings_clearing_agent_id_clearing_agents_id_fk" FOREIGN KEY ("clearing_agent_id") REFERENCES "public"."clearing_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transports" ADD CONSTRAINT "transports_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transports" ADD CONSTRAINT "transports_transport_company_id_transport_companies_id_fk" FOREIGN KEY ("transport_company_id") REFERENCES "public"."transport_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transports" ADD CONSTRAINT "transports_destination_id_locations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_receipt_lines" ADD CONSTRAINT "warehouse_receipt_lines_receipt_id_warehouse_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."warehouse_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_receipt_lines" ADD CONSTRAINT "warehouse_receipt_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_receipt_lines" ADD CONSTRAINT "warehouse_receipt_lines_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_receipts" ADD CONSTRAINT "warehouse_receipts_transport_id_transports_id_fk" FOREIGN KEY ("transport_id") REFERENCES "public"."transports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_receipts" ADD CONSTRAINT "warehouse_receipts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clearings_container_unique" ON "clearings" USING btree ("container_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transports_container_unique" ON "transports" USING btree ("container_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_receipts_transport_unique" ON "warehouse_receipts" USING btree ("transport_id");