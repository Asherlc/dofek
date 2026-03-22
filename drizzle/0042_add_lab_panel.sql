-- Create the lab_panel table to normalize panel data from FHIR DiagnosticReports
CREATE TABLE "fitness"."lab_panel" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  "external_id" text,
  "name" text NOT NULL,
  "loinc_code" text,
  "status" "fitness"."lab_result_status",
  "source_name" text,
  "recorded_at" timestamp with time zone NOT NULL,
  "issued_at" timestamp with time zone,
  "raw" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint

ALTER TABLE "fitness"."lab_panel"
  ADD CONSTRAINT "lab_panel_provider_id_provider_id_fk"
  FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id")
  ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

ALTER TABLE "fitness"."lab_panel"
  ADD CONSTRAINT "lab_panel_user_id_user_profile_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "fitness"."user_profile"("id")
  ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

CREATE UNIQUE INDEX "lab_panel_provider_external_idx"
  ON "fitness"."lab_panel" USING btree ("provider_id", "external_id");

--> statement-breakpoint

CREATE INDEX "lab_panel_recorded_idx"
  ON "fitness"."lab_panel" USING btree ("recorded_at");

--> statement-breakpoint

CREATE INDEX "lab_panel_user_provider_idx"
  ON "fitness"."lab_panel" USING btree ("user_id", "provider_id");

--> statement-breakpoint

-- Add panel_id FK column to lab_result (nullable -- not all results belong to a panel)
ALTER TABLE "fitness"."lab_result"
  ADD COLUMN "panel_id" uuid REFERENCES "fitness"."lab_panel"("id");

--> statement-breakpoint

CREATE INDEX "lab_result_panel_idx"
  ON "fitness"."lab_result" USING btree ("panel_id");

--> statement-breakpoint

-- Migrate existing panel_name data: create stub panels from distinct panel names,
-- then link lab_result rows to them.
INSERT INTO "fitness"."lab_panel" ("provider_id", "user_id", "name", "recorded_at", "source_name")
SELECT DISTINCT ON (lr.provider_id, lr.panel_name, lr.recorded_at::date)
  lr.provider_id,
  lr.user_id,
  lr.panel_name,
  lr.recorded_at,
  lr.source_name
FROM "fitness"."lab_result" lr
WHERE lr.panel_name IS NOT NULL;

--> statement-breakpoint

UPDATE "fitness"."lab_result" lr
SET panel_id = lp.id
FROM "fitness"."lab_panel" lp
WHERE lr.panel_name IS NOT NULL
  AND lr.provider_id = lp.provider_id
  AND lr.panel_name = lp.name
  AND lr.recorded_at::date = lp.recorded_at::date;

--> statement-breakpoint

ALTER TABLE "fitness"."lab_result" DROP COLUMN "panel_name";
