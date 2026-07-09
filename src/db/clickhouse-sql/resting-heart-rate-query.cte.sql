resting_heart_rate AS (
  SELECT
    toString(toDate(toTimeZone(ended_at, {{ timezone_param }}))) AS date,
    assumeNotNull(resting_hr) AS resting_hr
  FROM analytics.resting_heart_rate_sleep_window FINAL
  WHERE user_id = {{ user_id_param }}
    AND is_deleted = 0
    AND ended_at IS NOT NULL
    AND resting_hr IS NOT NULL
    {{ window_start_predicate }}
    AND toDate(toTimeZone(ended_at, {{ timezone_param }})) <= toDate({{ end_date_param }})
  ORDER BY user_id, date, duration_seconds DESC, ended_at DESC
  LIMIT 1 BY user_id, date
)
