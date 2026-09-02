ALTER TABLE fitness.activity
DROP CONSTRAINT activity_local_time_context_check,
ADD CONSTRAINT activity_local_time_context_check CHECK (
  (
    local_time_source = 'unknown'
    AND start_utc_offset_minutes IS NULL
    AND end_utc_offset_minutes IS NULL
  ) OR (
    local_time_source IN ('provider_timezone', 'device_timezone', 'user_home_timezone')
    AND NULLIF(BTRIM(timezone), '') IS NOT NULL
    AND start_utc_offset_minutes BETWEEN -840 AND 840
    AND (ended_at IS NULL OR end_utc_offset_minutes BETWEEN -840 AND 840)
  ) OR (
    local_time_source IN ('provider_offset', 'device_offset')
    AND timezone IS NULL
    AND start_utc_offset_minutes BETWEEN -840 AND 840
    AND (ended_at IS NULL OR end_utc_offset_minutes BETWEEN -840 AND 840)
  )
);

ALTER TABLE fitness.sleep_session
DROP CONSTRAINT sleep_session_local_time_context_check,
ADD CONSTRAINT sleep_session_local_time_context_check CHECK (
  (
    local_time_source = 'unknown'
    AND timezone IS NULL
    AND start_utc_offset_minutes IS NULL
    AND end_utc_offset_minutes IS NULL
  ) OR (
    local_time_source IN ('provider_timezone', 'device_timezone', 'user_home_timezone')
    AND NULLIF(BTRIM(timezone), '') IS NOT NULL
    AND start_utc_offset_minutes BETWEEN -840 AND 840
    AND (ended_at IS NULL OR end_utc_offset_minutes BETWEEN -840 AND 840)
  ) OR (
    local_time_source IN ('provider_offset', 'device_offset')
    AND timezone IS NULL
    AND start_utc_offset_minutes BETWEEN -840 AND 840
    AND (ended_at IS NULL OR end_utc_offset_minutes BETWEEN -840 AND 840)
  )
);
