-- Provider-agnostic orientation sample table for quaternion data from any source
-- (WHOOP BLE strap, Apple Watch, Garmin, etc.)

CREATE TABLE IF NOT EXISTS fitness.orientation_sample (
  recorded_at TIMESTAMPTZ NOT NULL,
  user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES fitness.user_profile(id),
  provider_id TEXT NOT NULL REFERENCES fitness.provider(id),
  device_id TEXT NOT NULL,
  quaternion_w REAL NOT NULL,
  quaternion_x REAL NOT NULL,
  quaternion_y REAL NOT NULL,
  quaternion_z REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS orientation_sample_user_time_idx
  ON fitness.orientation_sample (user_id, recorded_at);

SELECT create_hypertable(
  'fitness.orientation_sample',
  'recorded_at',
  if_not_exists => TRUE
);

-- Ensure the whoop_ble provider exists
INSERT INTO fitness.provider (id, name)
VALUES ('whoop_ble', 'WHOOP BLE')
ON CONFLICT (id) DO NOTHING;
