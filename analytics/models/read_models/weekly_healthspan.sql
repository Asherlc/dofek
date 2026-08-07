{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, week_start)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH {% if is_incremental() %}
target_state AS (
    SELECT
        coalesce(
            max(refreshed_at),
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
        ) AS last_refreshed_at
    FROM {{ this }} FINAL
),

existing_weeks AS (
    SELECT
        user_id,
        max(week_start) AS latest_materialized_week_start
    FROM {{ this }}
    GROUP BY user_id
),
{% endif %}

sleep_by_week AS (
    SELECT
        user_id,
        toMonday(toDate(started_at)) AS week_start,
        avg(duration_minutes) AS avg_sleep_min,
        stddevPop(
            if(
                toHour(started_at) < 12,
                toHour(started_at) * 60 + toMinute(started_at) + 1440,
                toHour(started_at) * 60 + toMinute(started_at)
            )
        ) AS bedtime_stddev_min
    FROM {{ ref('daily_sleep') }} FINAL
    WHERE is_deleted = 0
    GROUP BY user_id, toMonday(toDate(started_at))
),

resting_by_week AS (
    SELECT
        user_id,
        toMonday(toDate(ended_at)) AS week_start,
        avg(resting_hr) AS avg_resting_hr
    FROM {{ ref('resting_heart_rate_sleep_window') }} FINAL
    WHERE is_deleted = 0
        AND ended_at IS NOT null
        AND resting_hr IS NOT null
    GROUP BY user_id, toMonday(toDate(ended_at))
),

daily_metrics_by_week AS (
    SELECT
        user_id,
        toMonday(date) AS week_start,
        avg(steps) AS avg_steps,
        CAST(coalesce(sum(exercise_minutes), 0), 'Float64') AS weekly_exercise_min
    FROM analytics.v_daily_metrics
    GROUP BY user_id, toMonday(date)
),

zone_minutes_by_week AS (
    SELECT
        user_id,
        toMonday(toDate(started_at)) AS week_start,
        CAST(sum(aerobic_minutes), 'Float64') AS weekly_aerobic_min,
        CAST(sum(high_intensity_minutes), 'Float64') AS weekly_high_intensity_min
    FROM {{ ref('healthspan_activity_zone_minutes') }} FINAL
    WHERE is_deleted = 0
        AND started_at IS NOT null
    GROUP BY user_id, toMonday(toDate(started_at))
),

strength_by_week AS (
    SELECT
        user_id,
        toMonday(toDate(started_at)) AS week_start,
        countIf(canonical_type = 'strength') AS strength_sessions
    FROM {{ ref('deduped_activities') }} FINAL
    WHERE is_deleted = 0
        AND started_at IS NOT null
    GROUP BY user_id, toMonday(toDate(started_at))
),

vo2_by_week AS (
    SELECT
        user_id,
        toMonday(toDate(started_at)) AS week_start,
        argMax(vo2max, started_at) AS latest_vo2max
    FROM {{ ref('activity_vo2max_estimate') }} FINAL
    WHERE is_deleted = 0
    GROUP BY user_id, toMonday(toDate(started_at))
),

body_by_week AS (
    SELECT
        user_id,
        toMonday(date) AS week_start,
        argMax(weight_kg, (recorded_at, refresh_version, measurement_id)) AS weight_kg,
        argMax(body_fat_pct, (recorded_at, refresh_version, measurement_id)) AS body_fat_pct
    FROM {{ ref('daily_body_measurement') }} FINAL
    WHERE is_deleted = 0
    GROUP BY user_id, toMonday(date)
),

{% if is_incremental() %}
changed_body_weeks AS (
    SELECT DISTINCT
        user_id,
        toMonday(date) AS week_start
    FROM {{ ref('daily_body_measurement') }} FINAL
    WHERE refreshed_at > (SELECT last_refreshed_at FROM target_state)
),
{% endif %}

week_keys AS (
    SELECT
        user_id,
        week_start
    FROM sleep_by_week
    UNION DISTINCT
    SELECT
        user_id,
        week_start
    FROM resting_by_week
    UNION DISTINCT
    SELECT
        user_id,
        week_start
    FROM daily_metrics_by_week
    UNION DISTINCT
    SELECT
        user_id,
        week_start
    FROM zone_minutes_by_week
    UNION DISTINCT
    SELECT
        user_id,
        week_start
    FROM strength_by_week
    UNION DISTINCT
    SELECT
        user_id,
        week_start
    FROM vo2_by_week
    UNION DISTINCT
    SELECT
        user_id,
        week_start
    FROM body_by_week
),

week_keys_to_materialize AS (
    SELECT
        week_keys.user_id AS user_id,
        week_keys.week_start AS week_start
    FROM week_keys
    {% if is_incremental() %}
    LEFT JOIN existing_weeks
        ON existing_weeks.user_id = week_keys.user_id
    WHERE existing_weeks.user_id IS null
        OR week_keys.week_start >= existing_weeks.latest_materialized_week_start - INTERVAL 26 WEEK
    UNION DISTINCT
    SELECT
        changed_body_weeks.user_id AS user_id,
        changed_body_weeks.week_start AS week_start
    FROM changed_body_weeks
    {% endif %}
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    CAST(week_keys_to_materialize.user_id, 'UUID') AS user_id,
    CAST(week_keys_to_materialize.week_start, 'Date') AS week_start,
    sleep_by_week.avg_sleep_min AS avg_sleep_min,
    sleep_by_week.bedtime_stddev_min AS bedtime_stddev_min,
    resting_by_week.avg_resting_hr AS avg_resting_hr,
    daily_metrics_by_week.avg_steps AS avg_steps,
    vo2_by_week.latest_vo2max AS latest_vo2max,
    greatest(
        coalesce(zone_minutes_by_week.weekly_aerobic_min, toFloat64(0)),
        coalesce(daily_metrics_by_week.weekly_exercise_min, toFloat64(0))
    ) AS weekly_aerobic_min,
    coalesce(
        zone_minutes_by_week.weekly_high_intensity_min,
        toFloat64(0)
    ) AS weekly_high_intensity_min,
    CAST(strength_by_week.strength_sessions, 'Nullable(Float64)') AS sessions_per_week,
    body_by_week.weight_kg AS weight_kg,
    body_by_week.body_fat_pct AS body_fat_pct,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM week_keys_to_materialize
LEFT JOIN sleep_by_week
    ON sleep_by_week.user_id = week_keys_to_materialize.user_id
    AND sleep_by_week.week_start = week_keys_to_materialize.week_start
LEFT JOIN resting_by_week
    ON resting_by_week.user_id = week_keys_to_materialize.user_id
    AND resting_by_week.week_start = week_keys_to_materialize.week_start
LEFT JOIN daily_metrics_by_week
    ON daily_metrics_by_week.user_id = week_keys_to_materialize.user_id
    AND daily_metrics_by_week.week_start = week_keys_to_materialize.week_start
LEFT JOIN zone_minutes_by_week
    ON zone_minutes_by_week.user_id = week_keys_to_materialize.user_id
    AND zone_minutes_by_week.week_start = week_keys_to_materialize.week_start
LEFT JOIN strength_by_week
    ON strength_by_week.user_id = week_keys_to_materialize.user_id
    AND strength_by_week.week_start = week_keys_to_materialize.week_start
LEFT JOIN vo2_by_week
    ON vo2_by_week.user_id = week_keys_to_materialize.user_id
    AND vo2_by_week.week_start = week_keys_to_materialize.week_start
LEFT JOIN body_by_week
    ON body_by_week.user_id = week_keys_to_materialize.user_id
    AND body_by_week.week_start = week_keys_to_materialize.week_start
CROSS JOIN refresh_clock
