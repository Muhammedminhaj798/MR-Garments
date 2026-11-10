ALTER TABLE "suppliers" ADD COLUMN "code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "email" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "country" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "state" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "postal_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "payment_terms" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "tax_number" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Existing suppliers get SUP-001, SUP-002, ... in the order they were created (the order the lists show), so the
-- unique index below holds and every supplier has the code the Suppliers page lists (docs/suppliers.md).
UPDATE "suppliers" SET "code" = 'SUP-' || lpad(numbered.n::text, 3, '0')
FROM (SELECT id, row_number() OVER (ORDER BY created_at, name) AS n FROM "suppliers") AS numbered
WHERE "suppliers".id = numbered.id AND "suppliers"."code" = '';--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_code_unique" ON "suppliers" USING btree (upper("code")) WHERE code <> '';