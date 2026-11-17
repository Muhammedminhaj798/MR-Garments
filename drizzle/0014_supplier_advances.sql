-- 0014 supplier advance account (docs/supplier-advance.md). One new table, append-only ledger: receipts (advance paid to
-- a supplier before any order), allocations (part of a receipt applied to an order) and reversals (part of an allocation
-- given back). Purely additive: no existing table, column, constraint or row changes. A deleted order keeps its ledger
-- rows (order_id set null, po_number kept).
CREATE TABLE "supplier_advance_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"exchange_rate" numeric(12, 4) NOT NULL,
	"advance_id" uuid,
	"reversal_of" uuid,
	"order_id" uuid,
	"po_number" text DEFAULT '' NOT NULL,
	"entry_date" date NOT NULL,
	"mode" text DEFAULT '' NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "supplier_advance_entries_kind_check" CHECK (kind in ('receipt', 'allocation', 'reversal')),
	CONSTRAINT "supplier_advance_entries_currency_check" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "supplier_advance_entries_amount_check" CHECK (amount > 0),
	CONSTRAINT "supplier_advance_entries_exchange_rate_check" CHECK (exchange_rate > 0 and (currency <> 'INR' or exchange_rate = 1)),
	CONSTRAINT "supplier_advance_entries_shape_check" CHECK ((kind = 'receipt' and advance_id is null and reversal_of is null and order_id is null and po_number = '' and mode <> '')
        or (kind = 'allocation' and advance_id is not null and reversal_of is null and po_number <> '')
        or (kind = 'reversal' and advance_id is not null and reversal_of is not null and po_number <> ''))
);
--> statement-breakpoint
ALTER TABLE "supplier_advance_entries" ADD CONSTRAINT "supplier_advance_entries_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_advance_entries" ADD CONSTRAINT "supplier_advance_entries_advance_id_supplier_advance_entries_id_fk" FOREIGN KEY ("advance_id") REFERENCES "public"."supplier_advance_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_advance_entries" ADD CONSTRAINT "supplier_advance_entries_reversal_of_supplier_advance_entries_id_fk" FOREIGN KEY ("reversal_of") REFERENCES "public"."supplier_advance_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_advance_entries" ADD CONSTRAINT "supplier_advance_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_advance_entries_supplier_idx" ON "supplier_advance_entries" USING btree ("supplier_id","currency");--> statement-breakpoint
CREATE INDEX "supplier_advance_entries_order_idx" ON "supplier_advance_entries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "supplier_advance_entries_advance_idx" ON "supplier_advance_entries" USING btree ("advance_id");--> statement-breakpoint
CREATE INDEX "supplier_advance_entries_reversal_idx" ON "supplier_advance_entries" USING btree ("reversal_of");