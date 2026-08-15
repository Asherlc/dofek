ALTER TABLE "fitness"."health_event"
  ADD COLUMN "source_bundle" text,
  ADD COLUMN "metadata" jsonb;
