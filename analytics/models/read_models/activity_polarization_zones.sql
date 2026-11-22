{{ config(
    materialized='incremental',
    incremental_strategy='append',
    full_refresh=false,
    alias='activity_cycling_polarization',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1,
        'enable_materialized_cte': 1,
        'preferred_optimize_projection_name': 'by_activity_source_refresh_version'
    }
) }}

WITH activity_meta AS MATERIALIZED (
    SELECT
        summary.activity_id AS activity_id,
        summary.user_id AS user_id,
        summary.started_at AS started_at,
        summary.ended_at AS ended_at,
        summary.refresh_version AS refresh_version,
        user_profile.max_hr AS max_hr
    FROM {{ ref('activity_summary_rows') }} AS summary FINAL
    INNER JOIN {{ source('postgres_fitness', 'user_profile_current') }} AS user_profile
        ON user_profile.id = summary.user_id
    WHERE summary.is_deleted = 0
        AND summary.canonical_type = 'cycling'
        AND summary.ended_at > summary.started_at
        AND user_profile.max_hr > 0
),

{% if is_incremental() %}
prior_live AS MATERIALIZED (
    SELECT
        activity_id,
        user_id,
        started_at,
        ended_at,
        max_hr,
        source_sensor_version,
        refresh_version
    FROM {{ this }} FINAL
    WHERE is_deleted = 0
),
{% endif %}

activity_keys AS (
    -- Keep prior live keys so removal of cycling eligibility can retire them.
    -- Never-eligible rides (no positive max HR) are excluded so they cannot emit repeated tombstones.
    SELECT
        user_id,
        activity_id
    FROM activity_meta
    {% if is_incremental() %}
    UNION DISTINCT
    SELECT
        user_id,
        activity_id
    FROM prior_live
    {% endif %}
),

sample_versions AS (
    -- Only eligible rides need a sample clock; tombstones retire keys without source data.
    SELECT
        user_id,
        activity_id,
        max(refresh_version) AS source_sensor_version
    FROM {{ ref('activity_sensor_sample') }}
    WHERE (user_id, activity_id) IN (
        SELECT
            user_id,
            activity_id
        FROM activity_meta
    )
    GROUP BY user_id, activity_id
),

candidate_state AS (
    SELECT
        activity_keys.user_id AS user_id,
        activity_keys.activity_id AS activity_id,
        activity_meta.started_at AS started_at,
        activity_meta.ended_at AS ended_at,
        activity_meta.max_hr AS max_hr,
        activity_meta.refresh_version AS refresh_version,
        coalesce(sample_versions.source_sensor_version, toUInt64(0)) AS source_sensor_version,
        toUInt8(activity_meta.activity_id IS null) AS is_deleted
    FROM activity_keys
    LEFT JOIN activity_meta
        ON activity_meta.user_id = activity_keys.user_id
        AND activity_meta.activity_id = activity_keys.activity_id
    LEFT JOIN sample_versions
        ON sample_versions.user_id = activity_keys.user_id
        AND sample_versions.activity_id = activity_keys.activity_id
),

dirty_keys AS MATERIALIZED (
    SELECT
        candidate_state.user_id AS user_id,
        candidate_state.activity_id AS activity_id,
        candidate_state.started_at AS started_at,
        candidate_state.ended_at AS ended_at,
        candidate_state.max_hr AS max_hr,
        candidate_state.source_sensor_version AS source_sensor_version,
        candidate_state.is_deleted AS is_deleted
    FROM candidate_state
    {% if is_incremental() %}
    LEFT JOIN prior_live
        ON candidate_state.user_id = prior_live.user_id
        AND candidate_state.activity_id = prior_live.activity_id
    WHERE prior_live.activity_id IS null
        OR candidate_state.is_deleted = 1
        OR candidate_state.started_at != prior_live.started_at
        OR candidate_state.ended_at != prior_live.ended_at
        OR candidate_state.max_hr != prior_live.max_hr
        OR candidate_state.source_sensor_version != prior_live.source_sensor_version
    {% endif %}
    ORDER BY
        {% if is_incremental() %}
        coalesce(prior_live.refresh_version, candidate_state.refresh_version, toUInt64(0)),
        {% else %}
        coalesce(candidate_state.refresh_version, toUInt64(0)),
        {% endif %}
        candidate_state.user_id,
        candidate_state.activity_id
    LIMIT 32
),

filtered_heart_rate_samples AS (
    SELECT
        user_id,
        activity_id,
        recorded_at,
        scalar AS heart_rate,
        measurement_kind
    FROM {{ ref('activity_sensor_sample') }} FINAL
    PREWHERE channel = 'heart_rate'
        AND (user_id, activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM dirty_keys
            WHERE is_deleted = 0
        )
    WHERE is_deleted = 0
),

heart_rate_samples AS (
    SELECT
        dirty.user_id AS user_id,
        dirty.activity_id AS activity_id,
        dirty.ended_at AS ended_at,
        dirty.max_hr AS max_hr,
        sensor.recorded_at AS recorded_at,
        sensor.heart_rate AS heart_rate,
        sensor.measurement_kind AS measurement_kind,
        leadInFrame(sensor.recorded_at, 1, sensor.recorded_at + INTERVAL 10 SECOND) OVER (
            PARTITION BY dirty.user_id, dirty.activity_id
            ORDER BY sensor.recorded_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS next_recorded_at
    FROM dirty_keys AS dirty
    INNER JOIN filtered_heart_rate_samples AS sensor
        ON sensor.user_id = dirty.user_id
        AND sensor.activity_id = dirty.activity_id
    WHERE dirty.is_deleted = 0
        AND sensor.recorded_at >= dirty.started_at
        AND sensor.recorded_at <= dirty.ended_at
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
    dirty.activity_id AS activity_id,
    dirty.user_id AS user_id,
    'cycling' AS canonical_type,
    coalesce(dirty.started_at, toDateTime64(0, 6, 'UTC')) AS started_at,
    toNullable(toInt16(dirty.max_hr)) AS max_hr,
    coalesce(zone_times.z1_microseconds, toUInt64(0)) AS z1_microseconds,
    coalesce(zone_times.z2_microseconds, toUInt64(0)) AS z2_microseconds,
    coalesce(zone_times.z3_microseconds, toUInt64(0)) AS z3_microseconds,
    dirty.is_deleted AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at,
    coalesce(dirty.ended_at, toDateTime64(0, 6, 'UTC')) AS ended_at,
    dirty.source_sensor_version AS source_sensor_version
FROM dirty_keys AS dirty
LEFT JOIN zone_times
    ON zone_times.activity_id = dirty.activity_id
    AND zone_times.user_id = dirty.user_id
CROSS JOIN refresh_clock
