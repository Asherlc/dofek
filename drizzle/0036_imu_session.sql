CREATE TABLE IF NOT EXISTS fitness.imu_session (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id),
  provider_id text NOT NULL,
  external_id text NOT NULL,
  session_start_at timestamptz NOT NULL,
  sample_count bigint NOT NULL,
  observed_hz real,
  has_gyro boolean DEFAULT false NOT NULL,
  accel_freq_mode bigint DEFAULT 1 NOT NULL,
  gyro_freq_mode bigint,
  raw_data text,
  created_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE fitness.imu_session ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS imu_session_user_external_idx ON fitness.imu_session (user_id, provider_id, external_id);
CREATE INDEX IF NOT EXISTS imu_session_user_provider_idx ON fitness.imu_session (user_id, provider_id); -- noqa: PG01
CREATE INDEX IF NOT EXISTS imu_session_start_at_idx ON fitness.imu_session (session_start_at DESC); -- noqa: PG01
