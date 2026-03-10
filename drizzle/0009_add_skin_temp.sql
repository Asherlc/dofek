-- Add skin temperature column to daily_metrics (WHOOP recovery)
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "skin_temp_c" real;

-- Rename cardio_activity → activity
ALTER TABLE "fitness"."cardio_activity" RENAME TO "activity";
ALTER INDEX "fitness"."cardio_activity_provider_external_idx" RENAME TO "activity_provider_external_idx";
