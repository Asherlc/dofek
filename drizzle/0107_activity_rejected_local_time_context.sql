ALTER TABLE fitness.activity
  ADD COLUMN rejected_provider_timezone text,
  ADD COLUMN rejected_provider_start_utc_offset_minutes bigint,
  ADD COLUMN rejected_provider_end_utc_offset_minutes bigint;

ALTER TABLE fitness.activity
  DROP CONSTRAINT activity_local_time_context_check;

ALTER TABLE fitness.activity
  ADD CONSTRAINT activity_local_time_context_check
  CHECK (
    (
      local_time_source = 'unknown'
      AND start_utc_offset_minutes IS NULL
      AND end_utc_offset_minutes IS NULL
    ) OR (
      local_time_source IN (
        'provider_timezone',
        'device_timezone',
        'user_home_timezone',
        'gps_timezone',
        'home_zone_fallback'
      )
      AND NULLIF(btrim(timezone), '') IS NOT NULL
      AND start_utc_offset_minutes BETWEEN -840 AND 840
      AND (ended_at IS NULL OR end_utc_offset_minutes BETWEEN -840 AND 840)
    ) OR (
      local_time_source IN ('provider_offset', 'device_offset')
      AND timezone IS NULL
      AND start_utc_offset_minutes BETWEEN -840 AND 840
      AND (ended_at IS NULL OR end_utc_offset_minutes BETWEEN -840 AND 840)
    )
  ) NOT VALID;
