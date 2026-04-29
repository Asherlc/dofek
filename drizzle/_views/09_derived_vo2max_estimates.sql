-- Canonical definition of the fitness.derived_vo2max_estimates materialized view.
-- Derived per-activity VO2 Max estimates from raw power, speed, altitude, and heart-rate data.

CREATE OR REPLACE VIEW fitness.derived_vo2max_acsm_segments AS
WITH speed_samples AS (
  SELECT
    ds.activity_id,
    ds.user_id,
    a.activity_type,
    (a.started_at AT TIME ZONE 'UTC')::date AS activity_date,
    ds.recorded_at,
    ds.scalar AS speed_meters_per_second
  FROM fitness.deduped_sensor ds
  JOIN fitness.v_activity a ON a.id = ds.activity_id
  WHERE ds.channel = 'speed'
    AND ds.activity_id IS NOT NULL
    AND ds.scalar IS NOT NULL
    AND a.activity_type IN ('running', 'trail_running', 'walking', 'hiking')
),
segments AS (
  SELECT
    ss.activity_id,
    ss.user_id,
    ss.activity_type,
    ss.activity_date,
    ss.recorded_at,
    avg(speed_window.scalar) * 60.0 AS speed_meters_per_minute,
    avg(heart_rate_window.scalar) AS average_heart_rate,
    count(speed_window.scalar) AS speed_sample_count,
    count(heart_rate_window.scalar) AS heart_rate_sample_count,
    (
      SELECT altitude.scalar
      FROM fitness.deduped_sensor altitude
      WHERE altitude.activity_id = ss.activity_id
        AND altitude.channel = 'altitude'
        AND altitude.scalar IS NOT NULL
        AND altitude.recorded_at >= ss.recorded_at - interval '5 minutes'
        AND altitude.recorded_at <= ss.recorded_at
      ORDER BY altitude.recorded_at ASC
      LIMIT 1
    ) AS start_altitude_meters,
    (
      SELECT altitude.scalar
      FROM fitness.deduped_sensor altitude
      WHERE altitude.activity_id = ss.activity_id
        AND altitude.channel = 'altitude'
        AND altitude.scalar IS NOT NULL
        AND altitude.recorded_at >= ss.recorded_at - interval '5 minutes'
        AND altitude.recorded_at <= ss.recorded_at
      ORDER BY altitude.recorded_at DESC
      LIMIT 1
    ) AS end_altitude_meters
  FROM speed_samples ss
  JOIN fitness.deduped_sensor speed_window
    ON speed_window.activity_id = ss.activity_id
   AND speed_window.channel = 'speed'
   AND speed_window.scalar IS NOT NULL
   AND speed_window.recorded_at >= ss.recorded_at - interval '5 minutes'
   AND speed_window.recorded_at <= ss.recorded_at
  JOIN fitness.deduped_sensor heart_rate_window
    ON heart_rate_window.activity_id = ss.activity_id
   AND heart_rate_window.channel = 'heart_rate'
   AND heart_rate_window.scalar IS NOT NULL
   AND heart_rate_window.recorded_at >= ss.recorded_at - interval '5 minutes'
   AND heart_rate_window.recorded_at <= ss.recorded_at
  GROUP BY ss.activity_id, ss.user_id, ss.activity_type, ss.activity_date, ss.recorded_at
),
qualified_segments AS (
  SELECT
    segments.activity_id,
    segments.user_id,
    segments.activity_type,
    segments.activity_date,
    segments.recorded_at,
    segments.speed_meters_per_minute,
    COALESCE(
      (segments.end_altitude_meters - segments.start_altitude_meters)
        / NULLIF(segments.speed_meters_per_minute * 5.0, 0),
      0
    ) AS grade_fraction,
    segments.average_heart_rate,
    resting.resting_hr AS resting_heart_rate,
    profile.max_hr AS max_heart_rate
  FROM segments
  JOIN fitness.user_profile profile ON profile.id = segments.user_id
  JOIN LATERAL (
    SELECT derived.resting_hr
    FROM fitness.derived_resting_heart_rate derived
    WHERE derived.user_id = segments.user_id
      AND derived.date <= segments.activity_date
    ORDER BY derived.date DESC
    LIMIT 1
  ) resting ON true
  WHERE segments.speed_sample_count >= 30
    AND segments.heart_rate_sample_count >= 30
    AND profile.max_hr IS NOT NULL
),
estimates AS (
  SELECT
    user_id,
    activity_id,
    activity_date,
    activity_type,
    recorded_at,
    speed_meters_per_minute,
    grade_fraction,
    average_heart_rate,
    resting_heart_rate,
    max_heart_rate,
    (average_heart_rate - resting_heart_rate)::float
      / NULLIF(max_heart_rate - resting_heart_rate, 0) AS intensity_fraction
  FROM qualified_segments
  WHERE speed_meters_per_minute >= 40
    AND speed_meters_per_minute <= 450
    AND grade_fraction >= -0.15
    AND grade_fraction <= 0.15
    AND max_heart_rate > resting_heart_rate
),
best_per_activity AS (
  SELECT DISTINCT ON (activity_id)
    user_id,
    activity_id,
    activity_date,
    activity_type,
    speed_meters_per_minute,
    grade_fraction,
    average_heart_rate,
    resting_heart_rate,
    max_heart_rate,
    intensity_fraction,
    CASE
      WHEN speed_meters_per_minute >= 134 THEN
        (0.2 * speed_meters_per_minute + 0.9 * speed_meters_per_minute * grade_fraction + 3.5)
          / intensity_fraction
      ELSE
        (0.1 * speed_meters_per_minute + 1.8 * speed_meters_per_minute * grade_fraction + 3.5)
          / intensity_fraction
    END AS vo2max
  FROM estimates
  WHERE intensity_fraction >= 0.6
    AND intensity_fraction < 1.0
  ORDER BY activity_id, recorded_at DESC
)
SELECT
  user_id,
  activity_id,
  activity_date,
  activity_type,
  jsonb_build_object(
    'speedMetersPerMinute', round(speed_meters_per_minute::numeric, 1),
    'gradeFraction', round(grade_fraction::numeric, 4),
    'averageHeartRate', round(average_heart_rate::numeric, 1),
    'restingHeartRate', resting_heart_rate,
    'maxHeartRate', max_heart_rate
  ) AS inputs,
  vo2max::real
FROM best_per_activity
WHERE vo2max > 0
  AND vo2max IS NOT NULL;

--> statement-breakpoint

CREATE MATERIALIZED VIEW fitness.derived_vo2max_estimates AS
WITH power_samples AS (
  SELECT
    ds.activity_id,
    ds.user_id,
    a.activity_type,
    (a.started_at AT TIME ZONE 'UTC')::date AS activity_date,
    ds.recorded_at,
    ds.scalar AS power_watts
  FROM fitness.deduped_sensor ds
  JOIN fitness.v_activity a ON a.id = ds.activity_id
  WHERE ds.channel = 'power'
    AND ds.activity_id IS NOT NULL
    AND ds.scalar IS NOT NULL
),
rolling_power AS (
  SELECT
    activity_id,
    user_id,
    activity_type,
    activity_date,
    avg(power_watts) OVER (
      PARTITION BY activity_id
      ORDER BY recorded_at
      RANGE BETWEEN INTERVAL '299 seconds' PRECEDING AND CURRENT ROW
    ) AS five_minute_power_watts,
    extract(epoch FROM (
      recorded_at - min(recorded_at) OVER (
        PARTITION BY activity_id
        ORDER BY recorded_at
        RANGE BETWEEN INTERVAL '299 seconds' PRECEDING AND CURRENT ROW
      )
    )) AS window_seconds,
    count(*) OVER (
      PARTITION BY activity_id
      ORDER BY recorded_at
      RANGE BETWEEN INTERVAL '299 seconds' PRECEDING AND CURRENT ROW
    ) AS sample_count
  FROM power_samples
),
best_power AS (
  SELECT DISTINCT ON (activity_id)
    activity_id,
    user_id,
    activity_type,
    activity_date,
    five_minute_power_watts
  FROM rolling_power
  WHERE window_seconds >= 299
    AND sample_count >= 30
  ORDER BY activity_id, five_minute_power_watts DESC
),
activity_weight AS (
  SELECT
    bp.*,
    weight.weight_kg
  FROM best_power bp
  LEFT JOIN LATERAL (
    SELECT weight_kg
    FROM fitness.v_body_measurement bm
    WHERE bm.user_id = bp.user_id
      AND bm.weight_kg IS NOT NULL
      AND bm.recorded_at <= (bp.activity_date + interval '1 day')
    ORDER BY bm.recorded_at DESC
    LIMIT 1
  ) weight ON true
)
SELECT
  user_id,
  activity_id,
  activity_date,
  activity_type,
  'cycling_power_5m'::text AS method,
  jsonb_build_object(
    'fiveMinutePowerWatts', round(five_minute_power_watts::numeric, 1),
    'weightKg', weight_kg
  ) AS inputs,
  ((five_minute_power_watts / weight_kg) * 10.8 + 7)::real AS vo2max
FROM activity_weight
WHERE weight_kg > 0
  AND five_minute_power_watts >= 50
  AND five_minute_power_watts <= 700
  AND activity_type IN (
    'cycling',
    'road_cycling',
    'mountain_biking',
    'gravel_cycling',
    'indoor_cycling',
    'virtual_cycling',
    'e_bike_cycling',
    'cyclocross',
    'track_cycling',
    'bmx'
  )
UNION ALL
SELECT
  user_id,
  activity_id,
  activity_date,
  activity_type,
  'acsm_speed_grade_hr_5m'::text AS method,
  inputs,
  vo2max
FROM fitness.derived_vo2max_acsm_segments;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS derived_vo2max_estimates_activity_method_idx
  ON fitness.derived_vo2max_estimates (activity_id, method);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS derived_vo2max_estimates_user_date_idx
  ON fitness.derived_vo2max_estimates (user_id, activity_date DESC);
