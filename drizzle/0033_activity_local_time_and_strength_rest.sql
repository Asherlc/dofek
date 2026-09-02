ALTER TABLE fitness.activity
  ADD COLUMN IF NOT EXISTS start_utc_offset_minutes integer,
  ADD COLUMN IF NOT EXISTS end_utc_offset_minutes integer,
  ADD COLUMN IF NOT EXISTS local_time_source text NOT NULL DEFAULT 'unknown';

ALTER TYPE fitness.set_type ADD VALUE IF NOT EXISTS 'rest';
