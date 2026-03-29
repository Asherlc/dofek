-- Rename accelerometer_sample to inertial_measurement_unit_sample and add
-- gyroscope columns. With gyroscope data from Apple Watch (CMMotionManager)
-- and WHOOP BLE, this table stores full 6-axis IMU data, not just
-- accelerometer. The rename was previously attempted in-place in 0043 but
-- that migration had already been applied on production as accelerometer_sample.

-- 1. Rename the table
ALTER TABLE fitness.accelerometer_sample
  RENAME TO inertial_measurement_unit_sample;
--> statement-breakpoint

-- 2. Rename the index to match the new table name
ALTER INDEX fitness.accelerometer_user_time_idx
  RENAME TO inertial_measurement_unit_user_time_idx;
--> statement-breakpoint

-- 3. Add gyroscope columns (nullable — existing accel-only data keeps nulls)
ALTER TABLE fitness.inertial_measurement_unit_sample
  ADD COLUMN IF NOT EXISTS gyroscope_x real,
  ADD COLUMN IF NOT EXISTS gyroscope_y real,
  ADD COLUMN IF NOT EXISTS gyroscope_z real;
--> statement-breakpoint

-- 4. Recreate compression settings to include gyroscope columns.
--    TimescaleDB requires redefining compression when columns are added.
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
