-- ============================================================
-- Migration 0024: Sport settings, RPE, and activity intervals
-- ============================================================
-- 1. sport_settings table — per-sport zone thresholds (FTP, FTHR, pace)
-- 2. perceived_exertion column on activity table
-- 3. activity_interval table — structured laps/intervals within activities

-- ============================================================
-- 1. Sport settings — per-sport zone configuration
-- ============================================================
CREATE TABLE IF NOT EXISTS fitness.sport_settings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES fitness.user_profile(id),
  sport       TEXT NOT NULL,  -- e.g. 'cycling', 'running', 'swimming'
  -- Power zones (cycling)
  ftp         SMALLINT,       -- functional threshold power (watts)
  -- Heart rate zones
  threshold_hr SMALLINT,      -- functional threshold heart rate (bpm)
  -- Pace zones (running/swimming)
  threshold_pace_per_km REAL, -- threshold pace in seconds per km
  -- Zone boundaries stored as JSON arrays of breakpoints (percentages of threshold)
  -- e.g. [0.55, 0.75, 0.90, 1.05, 1.20] for 5-zone model
  power_zone_pcts   JSONB,
  hr_zone_pcts      JSONB,
  pace_zone_pcts    JSONB,
  -- Effective date range for tracking changes over time
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS sport_settings_user_sport_date_idx
  ON fitness.sport_settings (user_id, sport, effective_from);
CREATE INDEX IF NOT EXISTS sport_settings_user_idx
  ON fitness.sport_settings (user_id);

--> statement-breakpoint

-- ============================================================
-- 2. RPE (perceived exertion) on activity
-- ============================================================
ALTER TABLE fitness.activity
  ADD COLUMN IF NOT EXISTS perceived_exertion REAL;

--> statement-breakpoint

-- ============================================================
-- 3. Activity intervals / laps
-- ============================================================
CREATE TABLE IF NOT EXISTS fitness.activity_interval (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id   UUID NOT NULL REFERENCES fitness.activity(id) ON DELETE CASCADE,
  interval_index INT NOT NULL,       -- 0-based ordering
  label         TEXT,                 -- e.g. 'Warm Up', 'Interval 1', 'Rest', 'Lap 3'
  interval_type TEXT,                 -- 'lap', 'interval', 'rest', 'warmup', 'cooldown'
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  -- Summary metrics for this interval (from metric_stream samples in range)
  avg_heart_rate  REAL,
  max_heart_rate  SMALLINT,
  avg_power       REAL,
  max_power       SMALLINT,
  avg_speed       REAL,               -- m/s
  max_speed       REAL,               -- m/s
  avg_cadence     REAL,
  distance_meters REAL,
  elevation_gain  REAL,               -- meters
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS activity_interval_activity_idx
  ON fitness.activity_interval (activity_id, interval_index);
