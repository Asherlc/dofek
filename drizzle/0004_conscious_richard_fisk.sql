CREATE TABLE "fitness"."lab_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"external_id" text,
	"test_name" text NOT NULL,
	"loinc_code" text,
	"value" real,
	"value_text" text,
	"unit" text,
	"reference_range_low" real,
	"reference_range_high" real,
	"reference_range_text" text,
	"panel_name" text,
	"status" text,
	"source_name" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fitness"."lab_result" ADD CONSTRAINT "lab_result_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lab_result_provider_external_idx" ON "fitness"."lab_result" USING btree ("provider_id","external_id");--> statement-breakpoint
CREATE INDEX "lab_result_recorded_idx" ON "fitness"."lab_result" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "lab_result_loinc_idx" ON "fitness"."lab_result" USING btree ("loinc_code");--> statement-breakpoint
CREATE INDEX "lab_result_test_name_idx" ON "fitness"."lab_result" USING btree ("test_name");