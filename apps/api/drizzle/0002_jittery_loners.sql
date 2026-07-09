CREATE TABLE "move_up_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"service_code" text NOT NULL,
	"practitioner_id" text,
	"note" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "move_up_waiting_per_appointment_idx" ON "move_up_requests" USING btree ("appointment_id") WHERE "move_up_requests"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "move_up_status_created_idx" ON "move_up_requests" USING btree ("status","created_at");