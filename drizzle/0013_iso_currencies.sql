-- 0013 currency codes (docs/supplier-currency.md): any active ISO 4217 code may be a supplier's, order's or deposit's
-- currency. The database keeps the shape (three capitals); the API checks the code against the currency master
-- (src/currencies). Saved rows (CNY, USD, INR) all satisfy the new check, so nothing is rewritten.
ALTER TABLE "suppliers" DROP CONSTRAINT "suppliers_currency_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_currency_check";--> statement-breakpoint
ALTER TABLE "supplier_deposits" DROP CONSTRAINT "supplier_deposits_currency_check";--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_currency_check" CHECK (currency ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_currency_check" CHECK (currency ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "supplier_deposits" ADD CONSTRAINT "supplier_deposits_currency_check" CHECK (currency ~ '^[A-Z]{3}$');