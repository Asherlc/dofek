-- Rename accelerometer_sample to inertial_measurement_unit_sample and add
-- gyroscope columns. With gyroscope data from Apple Watch (CMMotionManager)
-- and WHOOP BLE, this table stores full 6-axis IMU data, not just accelerometer.

-- 1. Rename table (idempotent: skip if already renamed)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'fitness' AND tablename = 'accelerometer_sample') THEN
    ALTER TABLE fitness.accelerometer_sample RENAME TO inertial_measurement_unit_sample;
  END IF;
END $$;
--> statement-breakpoint

-- 2. Rename index (idempotent: skip if already renamed)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'accelerometer_user_time_idx') THEN
    ALTER INDEX accelerometer_user_time_idx RENAME TO inertial_measurement_unit_user_time_idx;
  END IF;
END $$;
--> statement-breakpoint

-- 3. Add gyroscope columns (nullable — existing accel-only data keeps nulls)
ALTER TABLE fitness.inertial_measurement_unit_sample
  ADD COLUMN IF NOT EXISTS gyroscope_x real,
  ADD COLUMN IF NOT EXISTS gyroscope_y real,
  ADD COLUMN IF NOT EXISTS gyroscope_z real;
--> statement-breakpoint

-- 4. Recreate compression settings to include gyroscope columns.
-- TimescaleDB requires dropping and re-adding the policy when changing
-- compress settings on a hypertable.
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
