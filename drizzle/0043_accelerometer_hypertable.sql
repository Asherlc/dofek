-- Accelerometer sample hypertable for high-frequency IMU data (50 Hz).
-- Designed for iPhone CMSensorRecorder initially, with Apple Watch and Whoop
-- BLE as future sources. At 50 Hz, expect ~4.3M rows/day per device.

CREATE TABLE IF NOT EXISTS fitness.accelerometer_sample (
  recorded_at  timestamptz NOT NULL,
  user_id      uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
                           REFERENCES fitness.user_profile(id),
  device_id    text        NOT NULL,  -- e.g., "iPhone 15 Pro", "Apple Watch Series 9"
  device_type  text        NOT NULL,  -- "iphone", "apple_watch", "whoop"
  provider_id  text        NOT NULL
                           REFERENCES fitness.provider(id),
  x            real        NOT NULL,  -- acceleration in g
  y            real        NOT NULL,  -- acceleration in g
  z            real        NOT NULL   -- acceleration in g
);

-- Convert to hypertable with 1-day chunks (good for ~86 MB/day uncompressed)
SELECT create_hypertable(
  'fitness.accelerometer_sample',
  'recorded_at',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- Index for user-scoped time-range queries
CREATE INDEX IF NOT EXISTS accelerometer_user_time_idx
  ON fitness.accelerometer_sample (user_id, recorded_at DESC);

-- Enable compression: segment by user+device, order by time
ALTER TABLE fitness.accelerometer_sample SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'user_id, device_id, device_type, provider_id',
  timescaledb.compress_orderby = 'recorded_at ASC'
);

-- Compress chunks older than 2 days (data is bulk-uploaded in arrears)
SELECT add_compression_policy(
  'fitness.accelerometer_sample',
  compress_after => INTERVAL '2 days',
  if_not_exists => TRUE
);

-- Retain 90 days of data, then auto-drop
SELECT add_retention_policy(
  'fitness.accelerometer_sample',
  drop_after => INTERVAL '90 days',
  if_not_exists => TRUE
);
