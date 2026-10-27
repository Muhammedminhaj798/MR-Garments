CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"country" text NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_type_check" CHECK (type in ('China office', 'India office', 'Warehouse')),
	CONSTRAINT "locations_country_check" CHECK (country in ('China', 'India')),
	CONSTRAINT "locations_status_check" CHECK (status in ('Active', 'Inactive'))
);
--> statement-breakpoint
CREATE TABLE "password_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_tokens_purpose_check" CHECK (purpose in ('reset', 'invite'))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" json NOT NULL,
	"expire" timestamp (6) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact_person" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "suppliers_currency_check" CHECK (currency = 'CNY'),
	CONSTRAINT "suppliers_status_check" CHECK (status in ('Active', 'Inactive'))
);
--> statement-breakpoint
CREATE TABLE "user_stage_grants" (
	"user_id" uuid NOT NULL,
	"stage" smallint NOT NULL,
	CONSTRAINT "user_stage_grants_user_id_stage_pk" PRIMARY KEY("user_id","stage"),
	CONSTRAINT "user_stage_grants_stage_check" CHECK (stage between 2 and 6)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" "citext" NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"role" text NOT NULL,
	"location_id" uuid,
	"language" text DEFAULT 'English' NOT NULL,
	"password_hash" text,
	"password_changed_at" timestamp with time zone,
	"last_sign_in_at" timestamp with time zone,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "users_role_check" CHECK (role in ('Management', 'Procurement', 'Accounts', 'China staff', 'India staff', 'Warehouse staff')),
	CONSTRAINT "users_status_check" CHECK (status in ('Active', 'Inactive'))
);
--> statement-breakpoint
ALTER TABLE "password_tokens" ADD CONSTRAINT "password_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_stage_grants" ADD CONSTRAINT "user_stage_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "locations_name_unique" ON "locations" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "password_tokens_user_idx" ON "password_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "session" USING btree ("expire");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_name_unique" ON "suppliers" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");