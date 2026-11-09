ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "deposit_required_cny" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_deposit_required_check" CHECK (deposit_required_cny is null or deposit_required_cny > 0);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK (kind in ('short-receipt', 'payment-recorded', 'container-loaded', 'container-sailed', 'container-arrived', 'warehouse-receipt-deleted'));