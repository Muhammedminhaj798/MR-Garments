CREATE TABLE "container_lines" (
	"container_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"bundles" integer NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "container_lines_container_id_order_line_id_pk" PRIMARY KEY("container_id","order_line_id"),
	CONSTRAINT "container_lines_bundles_check" CHECK (bundles >= 0),
	CONSTRAINT "container_lines_quantity_check" CHECK (quantity > 0)
);
--> statement-breakpoint
CREATE TABLE "containers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"shipping_agent_id" uuid NOT NULL,
	"terms" text NOT NULL,
	"port_of_loading" text DEFAULT '' NOT NULL,
	"port_of_arrival" text DEFAULT '' NOT NULL,
	"loaded_on" date,
	"sailed_on" date,
	"eta" date NOT NULL,
	"eta_estimated" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'loading' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "containers_terms_check" CHECK (terms in ('FOB', 'CNF')),
	CONSTRAINT "containers_status_check" CHECK (status in ('loading', 'sea', 'arrived'))
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"quantity" integer NOT NULL,
	"rate_cny" numeric(12, 4) NOT NULL,
	CONSTRAINT "order_lines_quantity_check" CHECK (quantity > 0),
	CONSTRAINT "order_lines_rate_check" CHECK (rate_cny >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_number" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"order_date" date NOT NULL,
	"delivery_date" date NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"stage" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "orders_currency_check" CHECK (currency = 'CNY'),
	CONSTRAINT "orders_stage_check" CHECK (stage between 1 and 6),
	CONSTRAINT "orders_dates_check" CHECK (delivery_date >= order_date)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payee" text NOT NULL,
	"payee_role" text NOT NULL,
	"amount_cny" numeric(14, 2) NOT NULL,
	"status" text NOT NULL,
	"paid_on" date,
	"due_date" date,
	"rate_inr" numeric(12, 4),
	"mode" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "payments_kind_check" CHECK (kind in ('Deposit', 'Balance')),
	CONSTRAINT "payments_payee_role_check" CHECK (payee_role in ('supplier', 'agent')),
	CONSTRAINT "payments_status_check" CHECK (status in ('paid', 'due')),
	CONSTRAINT "payments_amount_check" CHECK (amount_cny > 0),
	CONSTRAINT "payments_status_fields_check" CHECK ((status = 'paid' and paid_on is not null and rate_inr > 0 and coalesce(mode, '') <> '') or (status = 'due' and due_date is not null))
);
--> statement-breakpoint
CREATE TABLE "receipt_lines" (
	"receipt_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "receipt_lines_receipt_id_order_line_id_pk" PRIMARY KEY("receipt_id","order_line_id"),
	CONSTRAINT "receipt_lines_quantity_check" CHECK (quantity >= 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"received_on" date NOT NULL,
	"location_id" uuid NOT NULL,
	"received_by" uuid NOT NULL,
	"bundles" integer NOT NULL,
	"delivery_note" text DEFAULT '' NOT NULL,
	"short_remark" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_bundles_check" CHECK (bundles >= 0)
);
--> statement-breakpoint
ALTER TABLE "container_lines" ADD CONSTRAINT "container_lines_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_lines" ADD CONSTRAINT "container_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_shipping_agent_id_shipping_agents_id_fk" FOREIGN KEY ("shipping_agent_id") REFERENCES "public"."shipping_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "containers_number_unique" ON "containers" USING btree (upper("number"));--> statement-breakpoint
CREATE UNIQUE INDEX "order_lines_position_unique" ON "order_lines" USING btree ("order_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_po_number_unique" ON "orders" USING btree ("po_number");--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "receipts_order_idx" ON "receipts" USING btree ("order_id");