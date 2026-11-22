{{ config(
    materialized='incremental',
    incremental_strategy='append',
    alias='activity_cycling_polarization',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
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
        AND canonical_type = 'cycling'
        AND ended_at > started_at
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
    WHERE user_profile.max_hr > 0
),

heart_rate_samples AS (
    SELECT
        am.activity_id AS activity_id,
        am.user_id AS user_id,
        am.ended_at AS ended_at,
        am.max_hr AS max_hr,
        sensor.recorded_at AS recorded_at,
        sensor.scalar AS heart_rate,
        sensor.measurement_kind AS measurement_kind,
        leadInFrame(sensor.recorded_at, 1, sensor.recorded_at + INTERVAL 10 SECOND) OVER (
            PARTITION BY am.user_id, am.activity_id
            ORDER BY sensor.recorded_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS next_recorded_at
    FROM activity_meta AS am
    INNER JOIN {{ ref('activity_sensor_sample') }} AS sensor FINAL
        ON sensor.activity_id = am.activity_id
        AND sensor.user_id = am.user_id
        AND sensor.channel = 'heart_rate'
        AND sensor.is_deleted = 0
    WHERE sensor.recorded_at >= am.started_at
        AND sensor.recorded_at <= am.ended_at
),

covered_intervals AS (
    -- Match the aerobic-efficiency hold limit. Invalid and explicitly
    -- estimated readings end a prior interval without providing zone time.
    SELECT
        activity_id,
        user_id,
        heart_rate,
        max_hr * 80 / 100 AS middle_zone_start,
        max_hr * 90 / 100 AS high_zone_start,
        dateDiff(
            'microsecond',
            recorded_at,
            least(next_recorded_at, ended_at, recorded_at + INTERVAL 10 SECOND)
        ) AS covered_microseconds
    FROM heart_rate_samples
    WHERE heart_rate > 0
        AND isFinite(heart_rate)
        AND measurement_kind != 'estimated'
),

zone_times AS (
    SELECT
        intervals.activity_id AS activity_id,
        intervals.user_id AS user_id,
        sumIf(toUInt64(intervals.covered_microseconds), intervals.heart_rate < intervals.middle_zone_start)
            AS z1_microseconds,
        sumIf(
            toUInt64(intervals.covered_microseconds),
            intervals.heart_rate >= intervals.middle_zone_start AND intervals.heart_rate < intervals.high_zone_start
        ) AS z2_microseconds,
        sumIf(toUInt64(intervals.covered_microseconds), intervals.heart_rate >= intervals.high_zone_start)
            AS z3_microseconds
    FROM covered_intervals AS intervals
    WHERE intervals.covered_microseconds > 0
    GROUP BY
        intervals.activity_id,
        intervals.user_id
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    activity_keys.activity_id AS activity_id,
    activity_keys.user_id AS user_id,
    coalesce(activity_meta.canonical_type, null) AS canonical_type,
    coalesce(activity_meta.started_at, toDateTime64(0, 6, 'UTC')) AS started_at,
    toNullable(toInt16(activity_meta.max_hr)) AS max_hr,
    coalesce(zone_times.z1_microseconds, toUInt64(0)) AS z1_microseconds,
    coalesce(zone_times.z2_microseconds, toUInt64(0)) AS z2_microseconds,
    coalesce(zone_times.z3_microseconds, toUInt64(0)) AS z3_microseconds,
    if(activity_meta.activity_id IS null, 1, 0) AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM activity_keys
LEFT JOIN activity_meta
    ON activity_meta.activity_id = activity_keys.activity_id
    AND activity_meta.user_id = activity_keys.user_id
LEFT JOIN zone_times
    ON zone_times.activity_id = activity_keys.activity_id
    AND zone_times.user_id = activity_keys.user_id
CROSS JOIN refresh_clock
