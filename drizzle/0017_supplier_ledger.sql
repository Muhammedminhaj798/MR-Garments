CREATE TABLE "ledger_state" (
	"id" text PRIMARY KEY DEFAULT 'ledger' NOT NULL,
	"state" text DEFAULT 'maintenance' NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	CONSTRAINT "ledger_state_single_row_check" CHECK (id = 'ledger'),
	CONSTRAINT "ledger_state_state_check" CHECK (state in ('maintenance', 'live'))
);
--> statement-breakpoint
CREATE TABLE "supplier_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"entry_type" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"exchange_rate" numeric(12, 4),
	"entry_date" date NOT NULL,
	"origin" text NOT NULL,
	"balance_before" numeric(14, 2),
	"balance_after" numeric(14, 2),
	"payment_id" uuid,
	"advance_entry_id" uuid,
	"order_id" uuid,
	"po_number" text DEFAULT '' NOT NULL,
	"reverses_id" uuid,
	"idempotency_key" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "supplier_ledger_entries_type_check" CHECK (entry_type in ('payment', 'payment_void', 'order_debit', 'order_adjustment', 'order_cancel', 'adjustment')),
	CONSTRAINT "supplier_ledger_entries_origin_check" CHECK (origin in ('backfill', 'app')),
	CONSTRAINT "supplier_ledger_entries_currency_check" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "supplier_ledger_entries_sign_check" CHECK ((entry_type = 'payment' and amount > 0) or (entry_type = 'payment_void' and amount < 0)
        or (entry_type = 'order_debit' and amount <= 0) or (entry_type = 'order_cancel' and amount >= 0)
        or (entry_type in ('order_adjustment', 'adjustment') and amount <> 0)),
	CONSTRAINT "supplier_ledger_entries_shape_check" CHECK ((entry_type = 'payment' and num_nonnulls(payment_id, advance_entry_id) = 1 and order_id is null and reverses_id is null)
        or (entry_type = 'payment_void' and num_nonnulls(payment_id, advance_entry_id) = 1 and order_id is null and reverses_id is not null)
        or (entry_type in ('order_debit', 'order_adjustment', 'order_cancel') and payment_id is null and advance_entry_id is null and reverses_id is null and po_number <> '')
        or (entry_type = 'adjustment' and payment_id is null and advance_entry_id is null and order_id is null and reverses_id is null
            and origin = 'app' and btrim(notes) <> '' and exchange_rate is not null and created_by is not null
            and balance_before is not null and balance_after = balance_before + amount)),
	CONSTRAINT "supplier_ledger_entries_balances_check" CHECK ((entry_type = 'adjustment') = (balance_before is not null and balance_after is not null)),
	CONSTRAINT "supplier_ledger_entries_rate_check" CHECK (exchange_rate is null or (exchange_rate > 0 and (currency <> 'INR' or exchange_rate = 1)))
);
--> statement-breakpoint
CREATE TABLE "supplier_ledger_holds" (
	"supplier_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_ledger_holds_supplier_id_currency_pk" PRIMARY KEY("supplier_id","currency"),
	CONSTRAINT "supplier_ledger_holds_currency_check" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_kind_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "voided_by" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "void_reason" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "client_request_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_advance_entry_id_supplier_advance_entries_id_fk" FOREIGN KEY ("advance_entry_id") REFERENCES "public"."supplier_advance_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_reverses_id_supplier_ledger_entries_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."supplier_ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_ledger_holds" ADD CONSTRAINT "supplier_ledger_holds_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_ledger_entries_idempotency_unique" ON "supplier_ledger_entries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_ledger_entries_one_void_unique" ON "supplier_ledger_entries" USING btree ("reverses_id") WHERE entry_type = 'payment_void';--> statement-breakpoint
CREATE INDEX "supplier_ledger_entries_account_idx" ON "supplier_ledger_entries" USING btree ("supplier_id","currency","entry_date","created_at");--> statement-breakpoint
CREATE INDEX "supplier_ledger_entries_order_idx" ON "supplier_ledger_entries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "supplier_ledger_entries_payment_idx" ON "supplier_ledger_entries" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "supplier_ledger_entries_advance_idx" ON "supplier_ledger_entries" USING btree ("advance_entry_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_supplier_idx" ON "payments" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_client_request_unique" ON "payments" USING btree ("client_request_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_document_check" CHECK ((order_id is not null and supplier_id is null and currency is null) or (order_id is null and supplier_id is not null and currency is not null and payee_role = 'supplier'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_currency_check" CHECK (currency ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_void_check" CHECK ((voided_at is null and voided_by is null and void_reason = '') or (voided_at is not null and btrim(void_reason) <> ''));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_kind_check" CHECK (kind in ('Deposit', 'Balance', 'Payment'));--> statement-breakpoint
INSERT INTO "ledger_state" ("id", "state", "note") VALUES ('ledger', 'maintenance', 'Created by migration 0017: financial writes stay paused until scripts/ledger-reconcile.ts --open passes.');--> statement-breakpoint
CREATE FUNCTION "supplier_ledger_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The journal is append-only. The one change allowed is the orders foreign key setting order_id to null when ORD-6
  -- deletes an order whose cancellation was posted; every other column must stay as it was.
  IF TG_OP = 'UPDATE' AND OLD.order_id IS NOT NULL AND NEW.order_id IS NULL
     AND (to_jsonb(NEW) - 'order_id') = (to_jsonb(OLD) - 'order_id')
     AND NOT EXISTS (SELECT 1 FROM orders WHERE id = OLD.order_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'supplier_ledger_entries is append-only: % refused', TG_OP USING ERRCODE = 'P0001';
END
$$;--> statement-breakpoint
CREATE TRIGGER "supplier_ledger_append_only" BEFORE UPDATE OR DELETE ON "supplier_ledger_entries" FOR EACH ROW EXECUTE FUNCTION "supplier_ledger_append_only"();
