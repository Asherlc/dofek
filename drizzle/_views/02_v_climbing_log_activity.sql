CREATE OR REPLACE VIEW fitness.v_climbing_log_activity AS
WITH observations AS (
  SELECT
    point.user_id,
    point.provider_id,
    point.id AS activity_id,
    entry.id AS log_entry_id,
    point.external_id,
    point.started_at AS recorded_at,
    NULLIF(BTRIM(entry.board ->> 'externalId'), '') AS board_id,
    NULLIF(BTRIM(point.raw ->> 'gymExternalId'), '') AS gym_id
  FROM fitness.activity AS point
  INNER JOIN fitness.climbing_log_entry AS entry
    ON
      point.user_id = entry.user_id
      AND point.provider_id = entry.provider_id
      AND point.external_id = entry.external_id
      AND point.id = entry.activity_id
  WHERE
    point.provider_type = 'climbing_log'
    AND point.canonical_type = 'climbing'
    AND point.deleted_at IS NULL
    AND point.provider_absent_at IS NULL
    AND entry.provider_absent_at IS NULL
),

consecutive AS (
  SELECT
    *,
    LAG(recorded_at) OVER (
      PARTITION BY user_id, provider_id ORDER BY recorded_at, external_id
    ) AS previous_recorded_at
  FROM observations
),

time_groups AS (
  SELECT
    *,
    SUM(CASE
      WHEN
        previous_recorded_at IS NULL
        OR recorded_at - previous_recorded_at >= INTERVAL '10 minutes' THEN 1
      ELSE 0
    END) OVER (
      PARTITION BY user_id, provider_id ORDER BY recorded_at, external_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS time_group
  FROM consecutive
),

known_boards AS (
  SELECT
    activity_id,
    LAG(board_id) OVER (
      PARTITION BY user_id, provider_id, time_group ORDER BY recorded_at, external_id
    ) AS previous_board_id
  FROM time_groups
  WHERE board_id IS NOT NULL
),

known_gyms AS (
  SELECT
    activity_id,
    LAG(gym_id) OVER (
      PARTITION BY user_id, provider_id, time_group ORDER BY recorded_at, external_id
    ) AS previous_gym_id
  FROM time_groups
  WHERE gym_id IS NOT NULL
),

sessions AS (
  SELECT
    time_groups.*,
    SUM(CASE
      WHEN
        time_groups.previous_recorded_at IS NULL
        OR time_groups.recorded_at - time_groups.previous_recorded_at >= INTERVAL '10 minutes'
        OR time_groups.board_id <> known_boards.previous_board_id
        OR time_groups.gym_id <> known_gyms.previous_gym_id THEN 1
      ELSE 0
    END) OVER (
      PARTITION BY time_groups.user_id, time_groups.provider_id
      ORDER BY time_groups.recorded_at, time_groups.external_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS source_session
  FROM time_groups
  LEFT JOIN known_boards ON time_groups.activity_id = known_boards.activity_id
  LEFT JOIN known_gyms ON time_groups.activity_id = known_gyms.activity_id
)

SELECT
  user_id,
  provider_id,
  activity_id,
  log_entry_id,
  recorded_at,
  FIRST_VALUE(activity_id) OVER (
    PARTITION BY user_id, provider_id, source_session ORDER BY recorded_at, external_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
  ) AS session_id,
  MIN(recorded_at) OVER (PARTITION BY user_id, provider_id, source_session) AS first_logged_at,
  MAX(recorded_at) OVER (PARTITION BY user_id, provider_id, source_session) AS last_logged_at
FROM sessions;
