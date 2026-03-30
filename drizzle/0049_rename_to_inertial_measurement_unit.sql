-- Rename accelerometer_sample → inertial_measurement_unit_sample and add gyroscope columns.
-- The original 0043 migration was edited in-place to use the new name, but that edit
-- had no effect because 0043 was already applied with the old name. This migration
-- performs the actual rename and adds gyroscope columns for 6-axis IMU data.

-- 1. Rename the table (idempotent — skips if already renamed)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'fitness' AND table_name = 'accelerometer_sample'
  ) THEN
    ALTER TABLE fitness.accelerometer_sample
      RENAME TO inertial_measurement_unit_sample;
  END IF;
END $$;
--> statement-breakpoint

-- 2. Rename indexes to match new table name
ALTER INDEX IF EXISTS fitness.accelerometer_user_time_idx
  RENAME TO inertial_measurement_unit_user_time_idx;
--> statement-breakpoint

-- 3. Add gyroscope columns (nullable — existing accel-only data keeps nulls)
ALTER TABLE fitness.inertial_measurement_unit_sample
  ADD COLUMN IF NOT EXISTS gyroscope_x real,
  ADD COLUMN IF NOT EXISTS gyroscope_y real,
  ADD COLUMN IF NOT EXISTS gyroscope_z real;
--> statement-breakpoint

-- 4. Recreate compression settings to include gyroscope columns.
SELECT remove_compression_policy('fitness.inertial_measurement_unit_sample', if_exists => TRUE);
--> statement-breakpoint

ALTER TABLE fitness.inertial_measurement_unit_sample SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'user_id, device_id, device_type, provider_id',
  timescaledb.compress_orderby = 'recorded_at ASC'
);
--> statement-breakpoint

SELECT add_compression_policy(
  'fitness.inertial_measurement_unit_sample',
  compress_after => INTERVAL '2 days',
  if_not_exists => TRUE
);
