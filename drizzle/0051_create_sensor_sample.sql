-- ============================================================
-- Migration 0051: Create unified sensor_sample hypertable
-- ============================================================
-- Replaces metric_stream, inertial_measurement_unit_sample, and
-- orientation_sample with a single "medium layout" table.
--
-- Design:
--   channel (text)  — identifies what's measured (heart_rate, power, imu, etc.)
--   scalar  (real)  — single numeric value (HR bpm, power watts, etc.)
--   vector  (real[])— multi-axis data (accel [x,y,z], quaternion [w,x,y,z])
--   source_type     — informational only: 'ble', 'file', 'api'
--
-- Dedup strategy: per (activity_id, channel), pick the provider_id with
-- the most samples. The most granular source wins automatically.

CREATE TABLE IF NOT EXISTS fitness.sensor_sample (
  recorded_at   TIMESTAMPTZ NOT NULL,
  user_id       UUID        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
                            REFERENCES fitness.user_profile(id),
  provider_id   TEXT        NOT NULL
                            REFERENCES fitness.provider(id),
  device_id     TEXT,
  source_type   TEXT        NOT NULL,  -- 'ble', 'file', 'api'
  channel       TEXT        NOT NULL,  -- 'heart_rate', 'power', 'imu', 'orientation', etc.
  activity_id   UUID        REFERENCES fitness.activity(id) ON DELETE CASCADE,
  scalar        REAL,                  -- single numeric value
  vector        REAL[]                 -- multi-axis data
);

--> statement-breakpoint

-- Convert to hypertable with 1-day chunks.
-- High-frequency data (50 Hz IMU) can generate ~4.3M rows/day per device,
-- so daily chunks keep individual chunk sizes manageable.
SELECT create_hypertable(
  'fitness.sensor_sample',
  'recorded_at',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

--> statement-breakpoint

-- Primary read path: per-activity, per-channel time-series queries
CREATE INDEX IF NOT EXISTS sensor_sample_activity_channel_time_idx
  ON fitness.sensor_sample (activity_id, channel, recorded_at);

--> statement-breakpoint

-- User-scoped time-range queries (e.g., "last 90 days of heart_rate")
CREATE INDEX IF NOT EXISTS sensor_sample_user_channel_time_idx
  ON fitness.sensor_sample (user_id, channel, recorded_at);

--> statement-breakpoint

-- Provider disconnect cascade and per-provider queries
CREATE INDEX IF NOT EXISTS sensor_sample_provider_time_idx
  ON fitness.sensor_sample (provider_id, recorded_at);

--> statement-breakpoint

-- Enable compression: segment by user+provider+channel for best ratio.
-- All rows in a compressed segment share the same (user, provider, channel),
-- and the real/real[] values compress very well in columnar format.
ALTER TABLE fitness.sensor_sample SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'user_id, provider_id, channel',
  timescaledb.compress_orderby = 'recorded_at ASC'
);

--> statement-breakpoint

-- Compress chunks older than 2 days (matches existing IMU compression policy)
SELECT add_compression_policy(
  'fitness.sensor_sample',
  compress_after => INTERVAL '2 days',
  if_not_exists => TRUE
);
