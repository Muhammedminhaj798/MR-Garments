CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"symbol" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "units_name_key" UNIQUE("name"),
	CONSTRAINT "units_status_check" CHECK (status in ('Active', 'Inactive'))
);
--> statement-breakpoint
INSERT INTO "units" ("name", "symbol") VALUES ('Pieces', 'pcs'), ('Metres', 'm') ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "units" ("name", "symbol") VALUES ('Pieces', 'pcs'), ('Metres', 'm') ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "units" ("name", "symbol") VALUES ('Pieces', 'pcs'), ('Metres', 'm') ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "units" ("name", "symbol") VALUES ('Pieces', 'pcs'), ('Metres', 'm') ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT "items_counted_in_check";--> statement-breakpoint
DROP INDEX "orders_po_number_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "units_name_unique" ON "units" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_counted_in_units_name_fk" FOREIGN KEY ("counted_in") REFERENCES "public"."units"("name") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_po_number_unique" ON "orders" USING btree (lower("po_number"));