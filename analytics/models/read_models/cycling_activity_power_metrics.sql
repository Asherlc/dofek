-- depends_on: {{ source('analytics', 'activity_summary_rows') }}
-- depends_on: {{ source('analytics', 'cycling_power_observation_rows') }}
-- depends_on: {{ source('ingest', 'account_erasure_fence') }}

WITH activity_sources AS (
    SELECT
        summary.user_id AS user_id,
        summary.activity_id AS activity_id,
        summary.started_at AS started_at,
        summary.ended_at AS ended_at,
        coalesce(summary.canonical_type, '') AS canonical_type,
        coalesce(summary.power_sample_count, 0) AS power_sample_count,
        summary.refresh_version AS source_refresh_version
    FROM {{ source('analytics', 'activity_summary_rows') }} AS summary FINAL
    WHERE (coalesce(summary.power_sample_count, 0) > 0 OR summary.canonical_type = 'cycling')
        AND summary.is_deleted = 0
        AND summary.started_at IS NOT NULL
        AND summary.ended_at IS NOT NULL
        AND summary.ended_at <= now64(6, 'UTC')
),

current_observations AS (
    SELECT *
    FROM {{ source('analytics', 'cycling_power_observation_rows') }} FINAL
    WHERE is_deleted = 0
)

SELECT
    source.user_id AS user_id,
    source.activity_id AS activity_id,
    source.started_at AS started_at,
    source.ended_at AS ended_at,
    source.canonical_type AS canonical_type,
    source.power_sample_count AS power_sample_count,
    observation.normalized_power AS normalized_power
FROM activity_sources AS source
INNER JOIN current_observations AS observation USING (user_id, activity_id)
WHERE observation.source_refresh_version >= source.source_refresh_version
    AND lower(hex(SHA256(toString(source.user_id)))) NOT IN (
        SELECT user_hash FROM {{ source('ingest', 'account_erasure_fence') }} FINAL
    )
SETTINGS join_use_nulls = 1
