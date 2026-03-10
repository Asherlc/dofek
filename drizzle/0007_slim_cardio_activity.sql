-- Strip cardio_activity down to metadata only (no aggregate/computed columns)
ALTER TABLE "fitness"."cardio_activity" ADD COLUMN "name" text;
ALTER TABLE "fitness"."cardio_activity" DROP COLUMN IF EXISTS "duration_seconds";
ALTER TABLE "fitness"."cardio_activity" DROP COLUMN IF EXISTS "distance_meters";
ALTER TABLE "fitness"."cardio_activity" DROP COLUMN IF EXISTS "calories";
ALTER TABLE "fitness"."cardio_activity" DROP COLUMN IF EXISTS "avg_heart_rate";
ALTER TABLE "fitness"."cardio_activity" DROP COLUMN IF EXISTS "max_heart_rate";
ALTER TABLE "fitness"."cardio_activity" DROP COLUMN IF EXISTS "avg_power";
ALTER TABLE "fitness"."cardio_activity" DROP COLUMN IF EXISTS "max_power";
ALTER TABLE "fitness"."cardio_activity" DROP COLUMN IF EXISTS "avg_speed";
ALTER TABLE "fitness"."cardio_activity" DROP COLUMN IF EXISTS "max_speed";
ALTER TABLE "fitness"."cardio_activity" DROP COLUMN IF EXISTS "avg_cadence";
ALTER TABLE "fitness"."cardio_activity" DROP COLUMN IF EXISTS "total_elevation_gain";
ALTER TABLE "fitness"."cardio_activity" DROP COLUMN IF EXISTS "normalized_power";
ALTER TABLE "fitness"."cardio_activity" DROP COLUMN IF EXISTS "intensity_factor";
ALTER TABLE "fitness"."cardio_activity" DROP COLUMN IF EXISTS "tss";
