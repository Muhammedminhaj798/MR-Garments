CREATE TABLE "clearing_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact_person" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"port" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clearing_agents_status_check" CHECK (status in ('Active', 'Inactive'))
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"counted_in" text NOT NULL,
	"per_bundle" integer,
	"bundle_label" text,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_counted_in_check" CHECK (counted_in in ('Pieces', 'Metres')),
	CONSTRAINT "items_bundle_check" CHECK ((per_bundle is not null and per_bundle > 0 and bundle_label is null) or (per_bundle is null and bundle_label is not null)),
	CONSTRAINT "items_status_check" CHECK (status in ('Active', 'Inactive'))
);
--> statement-breakpoint
CREATE TABLE "shipping_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact_person" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"office_city" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_agents_status_check" CHECK (status in ('Active', 'Inactive'))
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_status_check" CHECK (status in ('Active', 'Inactive'))
);
--> statement-breakpoint
CREATE TABLE "transport_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact_person" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transport_companies_status_check" CHECK (status in ('Active', 'Inactive'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "clearing_agents_name_unique" ON "clearing_agents" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "items_name_unique" ON "items" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_agents_name_unique" ON "shipping_agents" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "teams_name_unique" ON "teams" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "transport_companies_name_unique" ON "transport_companies" USING btree (lower("name"));