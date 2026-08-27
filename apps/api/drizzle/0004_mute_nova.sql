CREATE TABLE "service_categories" (
	"code" text PRIMARY KEY NOT NULL,
	"display" text NOT NULL,
	"expected_return_interval_days" integer,
	"typical_ticket_cents" integer,
	"ticket_basis" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staged_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_system" text NOT NULL,
	"source_identity" text NOT NULL,
	"import_id" uuid NOT NULL,
	"patient_source_identity" text,
	"transaction_date" date NOT NULL,
	"service_category_raw" text,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staged_appointments" ALTER COLUMN "patient_source_identity" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "staged_appointments" ALTER COLUMN "status_raw" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "staged_consults" ALTER COLUMN "patient_source_identity" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "staged_appointments" ADD COLUMN "patient_name" text;--> statement-breakpoint
ALTER TABLE "staged_appointments" ADD COLUMN "dob" date;--> statement-breakpoint
ALTER TABLE "staged_appointments" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "staged_patients" ADD COLUMN "phone_type" text;--> statement-breakpoint
ALTER TABLE "staged_patients" ADD COLUMN "spend_cents" integer;--> statement-breakpoint
ALTER TABLE "staged_consults" DROP COLUMN "consult_at";--> statement-breakpoint
ALTER TABLE "staged_consults" ADD COLUMN "patient_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "staged_consults" ADD COLUMN "consult_date" date NOT NULL;--> statement-breakpoint
ALTER TABLE "staged_consults" ADD COLUMN "provider_raw" text;--> statement-breakpoint
ALTER TABLE "staged_consults" ADD COLUMN "quote_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "staged_consults" ADD COLUMN "booked_raw" text;--> statement-breakpoint
ALTER TABLE "staged_consults" ADD COLUMN "completed_raw" text;--> statement-breakpoint
ALTER TABLE "staged_transactions" ADD CONSTRAINT "staged_transactions_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staged_transactions_source_idx" ON "staged_transactions" USING btree ("source_system","source_identity");