-- 0012 supplier currency and exchange rate (docs/supplier-currency.md). A supplier's `exchange_rate` is INR per 1 unit
-- of its `currency` (1 for INR); new orders and supplier deposits snapshot it at creation and keep it. Rows from before
-- this migration keep null: an unknown historical rate is never invented. Only INR suppliers are backfilled, with 1.
ALTER TABLE "suppliers" ADD COLUMN "exchange_rate" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "rate_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "exchange_rate" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "supplier_deposits" ADD COLUMN "exchange_rate" numeric(12, 4);--> statement-breakpoint
UPDATE "suppliers" SET "exchange_rate" = 1 WHERE "currency" = 'INR' AND "exchange_rate" IS NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_exchange_rate_check" CHECK (exchange_rate is null or exchange_rate > 0);--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_inr_rate_check" CHECK (currency <> 'INR' or exchange_rate = 1);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_exchange_rate_check" CHECK (exchange_rate is null or exchange_rate > 0);--> statement-breakpoint
ALTER TABLE "supplier_deposits" ADD CONSTRAINT "supplier_deposits_exchange_rate_check" CHECK (exchange_rate is null or exchange_rate > 0);
