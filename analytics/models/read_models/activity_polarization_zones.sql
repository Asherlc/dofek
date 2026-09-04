{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH activity_bounds AS (
    SELECT
        activity_id,
        user_id,
        canonical_type,
        started_at,
        ended_at
    FROM {{ ref('activity_summary_rows') }} FINAL
    WHERE is_deleted = 0
        AND ended_at IS NOT NULL
),

{% if is_incremental() %}
existing_activities AS (
    SELECT DISTINCT
        activity_id,
        user_id
    FROM {{ this }} FINAL
    WHERE is_deleted = 0
),
{% endif %}

activity_keys AS (
    SELECT
        activity_id,
        user_id
    FROM activity_bounds
    {% if is_incremental() %}
    UNION DISTINCT
    SELECT
        activity_id,
        user_id
    FROM existing_activities
    {% endif %}
),

activity_meta AS (
    SELECT
        activity_bounds.activity_id AS activity_id,
        activity_bounds.user_id AS user_id,
        activity_bounds.canonical_type AS canonical_type,
        activity_bounds.started_at AS started_at,
        activity_bounds.ended_at AS ended_at,
        user_profile.max_hr AS max_hr
    FROM activity_bounds
    INNER JOIN {{ source('postgres_fitness', 'user_profile_current') }} AS user_profile
        ON user_profile.id = activity_bounds.user_id
    WHERE user_profile.max_hr IS NOT NULL
),

zone_counts AS (
    SELECT
        am.activity_id AS activity_id,
        am.user_id AS user_id,
        any(am.canonical_type) AS canonical_type,
        any(am.started_at) AS started_at,
        any(am.max_hr) AS max_hr,
        toInt32(countIf(sensor.scalar < am.max_hr * 0.8)) AS z1_seconds,
        toInt32(countIf(
            sensor.scalar >= am.max_hr * 0.8
            AND sensor.scalar < am.max_hr * 0.9
        )) AS z2_seconds,
        toInt32(countIf(sensor.scalar >= am.max_hr * 0.9)) AS z3_seconds
    FROM activity_meta AS am
    INNER JOIN {{ ref('activity_sensor_sample') }} AS sensor
        ON sensor.activity_id = am.activity_id
        AND sensor.user_id = am.user_id
        AND sensor.channel = 'heart_rate'
        AND sensor.scalar IS NOT NULL
        AND sensor.is_deleted = 0
    GROUP BY
        am.activity_id,
        am.user_id
    HAVING z1_seconds + z2_seconds + z3_seconds > 0
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    activity_keys.activity_id AS activity_id,
    activity_keys.user_id AS user_id,
    zone_counts.canonical_type AS canonical_type,
    zone_counts.started_at AS started_at,
    zone_counts.max_hr AS max_hr,
    coalesce(zone_counts.z1_seconds, 0) AS z1_seconds,
    coalesce(zone_counts.z2_seconds, 0) AS z2_seconds,
    coalesce(zone_counts.z3_seconds, 0) AS z3_seconds,
    if(zone_counts.activity_id IS NULL, 1, 0) AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM activity_keys
LEFT JOIN zone_counts
    ON zone_counts.activity_id = activity_keys.activity_id
    AND zone_counts.user_id = activity_keys.user_id
CROSS JOIN refresh_clock
