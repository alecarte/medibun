CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_system" text NOT NULL,
	"entity" text NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"row_count" integer NOT NULL,
	"staged_count" integer NOT NULL,
	"rejected_count" integer NOT NULL,
	"rejects_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staged_appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_system" text NOT NULL,
	"source_identity" text NOT NULL,
	"import_id" uuid NOT NULL,
	"patient_source_identity" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"status_raw" text NOT NULL,
	"service_category_raw" text,
	"provider_raw" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staged_consults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_system" text NOT NULL,
	"source_identity" text NOT NULL,
	"import_id" uuid NOT NULL,
	"patient_source_identity" text NOT NULL,
	"consult_at" timestamp with time zone NOT NULL,
	"service_category_raw" text,
	"outcome_raw" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staged_inquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_system" text NOT NULL,
	"source_identity" text NOT NULL,
	"import_id" uuid NOT NULL,
	"patient_source_identity" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"channel_raw" text,
	"outcome_raw" text,
	"name" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staged_patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_system" text NOT NULL,
	"source_identity" text NOT NULL,
	"import_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"dob" date,
	"phone" text,
	"email" text,
	"medplum_patient_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staged_appointments" ADD CONSTRAINT "staged_appointments_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staged_consults" ADD CONSTRAINT "staged_consults_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staged_inquiries" ADD CONSTRAINT "staged_inquiries_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staged_patients" ADD CONSTRAINT "staged_patients_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staged_appointments_source_idx" ON "staged_appointments" USING btree ("source_system","source_identity");--> statement-breakpoint
CREATE UNIQUE INDEX "staged_consults_source_idx" ON "staged_consults" USING btree ("source_system","source_identity");--> statement-breakpoint
CREATE UNIQUE INDEX "staged_inquiries_source_idx" ON "staged_inquiries" USING btree ("source_system","source_identity");--> statement-breakpoint
CREATE UNIQUE INDEX "staged_patients_source_idx" ON "staged_patients" USING btree ("source_system","source_identity");