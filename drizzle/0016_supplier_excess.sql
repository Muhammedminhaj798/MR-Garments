-- 0016 supplier excess (docs/supplier-advance.md "Excess payments"): supplier money paid on an order beyond its value
-- becomes available supplier advance. Two ledger kinds: excess (a lot, linked to its order and payment) and
-- excess_return (part of an excess taken back). Additive: one nullable column (payment_id, set null when the payment is
-- deleted), its index, and wider kind/shape checks; every existing row already satisfies the new checks. No backfill:
-- orders overpaid before 0016 get their excess from a reviewed, separate script (none is written here).
ALTER TABLE "supplier_advance_entries" DROP CONSTRAINT "supplier_advance_entries_kind_check";--> statement-breakpoint
ALTER TABLE "supplier_advance_entries" DROP CONSTRAINT "supplier_advance_entries_shape_check";--> statement-breakpoint
ALTER TABLE "supplier_advance_entries" ADD COLUMN "payment_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_advance_entries" ADD CONSTRAINT "supplier_advance_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_advance_entries_payment_idx" ON "supplier_advance_entries" USING btree ("payment_id");--> statement-breakpoint
ALTER TABLE "supplier_advance_entries" ADD CONSTRAINT "supplier_advance_entries_kind_check" CHECK (kind in ('receipt', 'allocation', 'reversal', 'excess', 'excess_return'));--> statement-breakpoint
ALTER TABLE "supplier_advance_entries" ADD CONSTRAINT "supplier_advance_entries_shape_check" CHECK ((kind = 'receipt' and advance_id is null and reversal_of is null and order_id is null and po_number = '' and mode <> '' and payment_id is null)
        or (kind = 'allocation' and advance_id is not null and reversal_of is null and po_number <> '' and payment_id is null)
        or (kind = 'reversal' and advance_id is not null and reversal_of is not null and po_number <> '' and payment_id is null)
        or (kind = 'excess' and advance_id is null and reversal_of is null and po_number <> '')
        or (kind = 'excess_return' and advance_id is not null and reversal_of is null and po_number <> '' and payment_id is null));