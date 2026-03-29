-- Add gyroscope columns to the inertial measurement unit sample table.
-- With gyroscope data from Apple Watch (CMMotionManager) and WHOOP BLE,
-- this table stores full 6-axis IMU data, not just accelerometer.
--
-- Note: The table rename from accelerometer_sample to inertial_measurement_unit_sample
-- is handled in 0043_accelerometer_hypertable.sql (updated in-place).

-- 1. Add gyroscope columns (nullable — existing accel-only data keeps nulls)
ALTER TABLE fitness.inertial_measurement_unit_sample
  ADD COLUMN IF NOT EXISTS gyroscope_x real,
  ADD COLUMN IF NOT EXISTS gyroscope_y real,
  ADD COLUMN IF NOT EXISTS gyroscope_z real;
--> statement-breakpoint

-- 2. Recreate compression settings to include gyroscope columns.
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
