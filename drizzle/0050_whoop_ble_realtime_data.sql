-- Store raw WHOOP BLE realtime data (0x28 packets): heart rate, orientation quaternion, raw payload.
-- HR is also written to metric_stream for unified HR queries across providers.
-- This table preserves the full raw record including quaternion and raw payload hex.

CREATE TABLE IF NOT EXISTS fitness.whoop_ble_realtime_data (
  recorded_at TIMESTAMPTZ NOT NULL,
  user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES fitness.user_profile(id),
  provider_id TEXT NOT NULL REFERENCES fitness.provider(id),
  heart_rate SMALLINT,
  quaternion_w REAL,
  quaternion_x REAL,
  quaternion_y REAL,
  quaternion_z REAL,
  raw_payload TEXT
);

CREATE INDEX IF NOT EXISTS whoop_ble_realtime_user_time_idx
  ON fitness.whoop_ble_realtime_data (user_id, recorded_at);

SELECT create_hypertable(
  'fitness.whoop_ble_realtime_data',
  'recorded_at',
  if_not_exists => TRUE
);

-- Ensure the whoop_ble provider exists
INSERT INTO fitness.provider (id, name)
VALUES ('whoop_ble', 'WHOOP BLE')
ON CONFLICT (id) DO NOTHING;
