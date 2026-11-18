-- 0015 order container terms (docs/order-container-terms.md): FOB or CNF is chosen on the order, and a container takes
-- the terms of the orders loaded into it. Additive: one nullable column and its check. Containers keep their terms
-- (history and every cost read them). Backfill: an order already in containers takes their terms when they all agree;
-- an order never loaded, or loaded into containers with different terms, stays null (set on Edit order).
ALTER TABLE "orders" ADD COLUMN "terms" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_terms_check" CHECK (terms in ('FOB', 'CNF'));--> statement-breakpoint
UPDATE "orders" SET "terms" = loaded."terms"
FROM (
	SELECT "order_lines"."order_id", min("containers"."terms") AS "terms"
	FROM "container_lines"
	JOIN "order_lines" ON "order_lines"."id" = "container_lines"."order_line_id"
	JOIN "containers" ON "containers"."id" = "container_lines"."container_id"
	GROUP BY "order_lines"."order_id"
	HAVING count(DISTINCT "containers"."terms") = 1
) AS loaded
WHERE "orders"."id" = loaded."order_id";
