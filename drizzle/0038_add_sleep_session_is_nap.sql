ALTER TABLE fitness.sleep_session
ADD COLUMN is_nap boolean NOT NULL DEFAULT false;

-- Rows default to false; only rows that should be naps need updating
UPDATE fitness.sleep_session
SET is_nap = true
WHERE
  CASE
    WHEN sleep_type IN ('nap', 'late_nap', 'rest') THEN true
    WHEN sleep_type IN ('sleep', 'long_sleep', 'main') THEN false
    WHEN sleep_type = 'not_main' THEN COALESCE(duration_minutes < 120, true)
    ELSE COALESCE(duration_minutes < 120, false)
  END;
