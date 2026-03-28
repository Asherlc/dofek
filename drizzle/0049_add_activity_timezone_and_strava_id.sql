-- Add timezone and strava_id columns to the activity table.
-- timezone: IANA timezone name (e.g. "America/New_York") to preserve local time-of-day.
-- strava_id: cross-provider link to Strava activity (matches external_id where provider_id = 'strava').

ALTER TABLE fitness.activity
  ADD COLUMN IF NOT EXISTS timezone TEXT,
  ADD COLUMN IF NOT EXISTS strava_id TEXT;

--> statement-breakpoint

-- Backfill timezone from raw JSONB for existing Peloton activities
UPDATE fitness.activity
  SET timezone = raw->>'timezone'
  WHERE provider_id = 'peloton'
    AND raw->>'timezone' IS NOT NULL
    AND timezone IS NULL;

-- v_activity and activity_summary are recreated from drizzle/views/ by the migration runner.
