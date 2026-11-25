-- Owner approval of 2026-11-25 (Supplier Full History, phase 2): two indexes, schema only. No data, formula or rule
-- changes. The order reports sum received (China) and stocked (India) quantities per order line; both tables' primary
-- keys lead with receipt_id, so each line's sum scanned the whole table. Plain CREATE INDEX: drizzle runs migrations in
-- one transaction (CONCURRENTLY is refused there), and both tables are small (a brief write lock while each builds).
CREATE INDEX "receipt_lines_order_line_idx" ON "receipt_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "warehouse_receipt_lines_order_line_idx" ON "warehouse_receipt_lines" USING btree ("order_line_id");
