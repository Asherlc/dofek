-- Expand schema to support all Apple Health data types

-- metric_stream: add blood glucose and audio exposure
ALTER TABLE "fitness"."metric_stream" ADD COLUMN "blood_glucose" real;
ALTER TABLE "fitness"."metric_stream" ADD COLUMN "audio_exposure" real;

-- daily_metrics: add activity, walking, and audio columns
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "distance_km" real;
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "cycling_distance_km" real;
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "flights_climbed" integer;
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "exercise_minutes" integer;
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "mindful_minutes" integer;
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "walking_speed" real;
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "walking_step_length" real;
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "walking_double_support_pct" real;
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "walking_asymmetry_pct" real;
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "walking_steadiness" real;
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "stand_hours" integer;
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "environmental_audio_exposure" real;
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "headphone_audio_exposure" real;

-- body_measurement: add height and waist
ALTER TABLE "fitness"."body_measurement" ADD COLUMN "height_cm" real;
ALTER TABLE "fitness"."body_measurement" ADD COLUMN "waist_circumference_cm" real;

-- health_event: generic catch-all for category types and unrouted records
CREATE TABLE "fitness"."health_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" text NOT NULL REFERENCES "fitness"."provider"("id"),
  "external_id" text,
  "type" text NOT NULL,
  "value" real,
  "value_text" text,
  "unit" text,
  "source_name" text,
  "start_date" timestamp with time zone NOT NULL,
  "end_date" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "health_event_provider_external_idx" ON "fitness"."health_event" USING btree ("provider_id", "external_id");
CREATE INDEX "health_event_type_time_idx" ON "fitness"."health_event" USING btree ("type", "start_date");
