CREATE TABLE "final_cost_protections" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"protected_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "final_cost_protections_currency_check" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "final_cost_protections" ADD CONSTRAINT "final_cost_protections_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "final_cost_protections" ADD CONSTRAINT "final_cost_protections_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "final_cost_protections_account_idx" ON "final_cost_protections" USING btree ("supplier_id","currency");--> statement-breakpoint
CREATE FUNCTION "final_cost_protections_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- An order that reached final landed cost stays protected for good (owner review of 2026-11-23).
  RAISE EXCEPTION 'final_cost_protections is append-only: % refused', TG_OP USING ERRCODE = 'P0001';
END
$$;--> statement-breakpoint
CREATE TRIGGER "final_cost_protections_append_only" BEFORE UPDATE OR DELETE ON "final_cost_protections" FOR EACH ROW EXECUTE FUNCTION "final_cost_protections_append_only"();
