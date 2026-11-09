CREATE TABLE "supplier_deposit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deposit_id" uuid NOT NULL,
	"paid_on" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"mode" text NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "supplier_deposit_transactions_amount_check" CHECK (amount > 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"opened_on" date NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "supplier_deposits_direction_check" CHECK (direction in ('give', 'receive')),
	CONSTRAINT "supplier_deposits_currency_check" CHECK (currency in ('CNY', 'USD', 'INR')),
	CONSTRAINT "supplier_deposits_amount_check" CHECK (amount > 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reference" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_deposit_transactions" ADD CONSTRAINT "supplier_deposit_transactions_deposit_id_supplier_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."supplier_deposits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_deposits" ADD CONSTRAINT "supplier_deposits_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_deposit_transactions_deposit_idx" ON "supplier_deposit_transactions" USING btree ("deposit_id");--> statement-breakpoint
CREATE INDEX "supplier_deposits_supplier_idx" ON "supplier_deposits" USING btree ("supplier_id");