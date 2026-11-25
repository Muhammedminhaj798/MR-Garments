ALTER TABLE "orders" ADD COLUMN "usd_rate" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_usd_rate_check" CHECK (usd_rate is null or usd_rate > 0);--> statement-breakpoint
-- Historical orders (owner decisions of 2026-11-24): only rates the records prove, never today's. A held account's
-- orders (D4, supplier_ledger_holds) are not touched. A USD order's USD rate is its own saved rate.
UPDATE "orders" SET "usd_rate" = "exchange_rate" WHERE "currency" = 'USD' AND "exchange_rate" IS NOT NULL AND "usd_rate" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "supplier_ledger_holds" h WHERE h."supplier_id" = "orders"."supplier_id" AND h."currency" = "orders"."currency");--> statement-breakpoint
-- Any other order: the USD rate in force when it was entered (created_at, not its order date), by the rule new orders
-- use: the one rate the active USD suppliers with a rate agree on (none when missing or conflicting). Only when the
-- records prove every supplier's state at that moment: no supplier that existed then has had its currency or rate
-- changed since (rate_updated_at after the order, or a rate with no recorded moment), and no USD supplier has been
-- edited since (its status then would be unknown). Otherwise it stays null ("No USD rate saved").
WITH "proven" AS (
  SELECT o."id",
    (SELECT array_agg(DISTINCT s."exchange_rate") FROM "suppliers" s
      WHERE s."currency" = 'USD' AND s."status" = 'Active' AND s."exchange_rate" IS NOT NULL AND s."created_at" <= o."created_at") AS "rates"
  FROM "orders" o
  WHERE o."currency" <> 'USD' AND o."usd_rate" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "supplier_ledger_holds" h WHERE h."supplier_id" = o."supplier_id" AND h."currency" = o."currency")
    AND NOT EXISTS (
      SELECT 1 FROM "suppliers" s
      WHERE s."created_at" <= o."created_at"
        AND ((s."rate_updated_at" IS NULL AND s."exchange_rate" IS NOT NULL)
          OR s."rate_updated_at" > o."created_at"
          OR (s."currency" = 'USD' AND s."updated_at" > o."created_at"))
    )
)
UPDATE "orders" o SET "usd_rate" = p."rates"[1] FROM "proven" p WHERE o."id" = p."id" AND cardinality(p."rates") = 1;
