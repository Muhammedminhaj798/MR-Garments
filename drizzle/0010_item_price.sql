ALTER TABLE "items" DROP CONSTRAINT "items_bundle_check";--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "price" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_price_check" CHECK (price is null or price >= 0);