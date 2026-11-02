ALTER TABLE "suppliers" DROP CONSTRAINT "suppliers_currency_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_currency_check";--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_currency_check" CHECK (currency in ('CNY', 'USD', 'INR'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_currency_check" CHECK (currency in ('CNY', 'USD', 'INR'));