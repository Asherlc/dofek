CREATE OR REPLACE VIEW fitness.v_climbing_log_activity AS
WITH source_partitions AS (
  SELECT DISTINCT
    user_id,
    provider_id
  FROM fitness.activity
  WHERE
    provider_type = 'climbing_log'
    AND canonical_type = 'climbing'
    AND deleted_at IS NULL
    AND provider_absent_at IS NULL
)

SELECT
  selected.user_id,
  selected.provider_id,
  projected.activity_id,
  projected.log_entry_id,
  projected.recorded_at,
  projected.session_id,
  projected.first_logged_at,
  projected.last_logged_at
FROM source_partitions AS selected
CROSS JOIN LATERAL (
  WITH RECURSIVE observations AS (
    SELECT
      point.user_id,
      point.provider_id,
      point.id AS activity_id,
      entry.id AS log_entry_id,
      point.external_id,
      point.started_at AS recorded_at,
      NULLIF(BTRIM(entry.board ->> 'externalId'), '') AS board_id,
      NULLIF(BTRIM(point.raw ->> 'gymExternalId'), '') AS gym_id,
      ROW_NUMBER() OVER (
        PARTITION BY point.user_id, point.provider_id
        ORDER BY point.started_at, point.external_id
      ) AS observation_index
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
      AND point.user_id = selected.user_id
      AND point.provider_id = selected.provider_id
  ),

  sessions AS (
    SELECT
      *,
      activity_id AS session_id,
      board_id AS known_board_id,
      gym_id AS known_gym_id
    FROM observations
    WHERE observation_index = 1
    UNION ALL
    SELECT
      observation.*,
      CASE WHEN boundary.starts_session THEN observation.activity_id ELSE previous.session_id END AS session_id,
      CASE
        WHEN boundary.starts_session THEN observation.board_id
        ELSE COALESCE(observation.board_id, previous.known_board_id)
      END AS known_board_id,
      CASE
        WHEN boundary.starts_session THEN observation.gym_id
        ELSE COALESCE(observation.gym_id, previous.known_gym_id)
      END AS known_gym_id
    FROM sessions AS previous
    INNER JOIN observations AS observation
      ON
        previous.user_id = observation.user_id
        AND previous.provider_id = observation.provider_id
        AND observation.observation_index = previous.observation_index + 1
    CROSS JOIN LATERAL (
      VALUES (COALESCE(
        observation.recorded_at - previous.recorded_at >= INTERVAL '10 minutes'
        OR observation.board_id <> previous.known_board_id
        OR observation.gym_id <> previous.known_gym_id,
        FALSE
      ))
    ) AS boundary (starts_session)
  )

  SELECT
    selected.user_id,
    selected.provider_id,
    sessions.activity_id,
    sessions.log_entry_id,
    sessions.recorded_at,
    sessions.session_id,
    MIN(sessions.recorded_at) OVER (PARTITION BY sessions.user_id, sessions.provider_id, sessions.session_id) AS first_logged_at,
    MAX(sessions.recorded_at) OVER (PARTITION BY sessions.user_id, sessions.provider_id, sessions.session_id) AS last_logged_at
  FROM sessions
) AS projected;
