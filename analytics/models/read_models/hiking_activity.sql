{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH activity_summary AS (
    SELECT
        activity_id,
        user_id,
        canonical_type,
        modality,
        name,
        started_at,
        ended_at,
        coalesce(total_distance, 0) AS distance_m,
        coalesce(elevation_gain_m, 0) AS elevation_gain_m,
        coalesce(elevation_loss_m, 0) AS elevation_loss_m,
        avg_hr,
        refreshed_at
    FROM {{ ref('activity_summary_rows') }} FINAL
    WHERE is_deleted = 0
        AND (
            canonical_type IN ('walking', 'hiking')
            OR (canonical_type = 'running' AND modality = 'trail')
        )
),

target_state AS (
    SELECT
        coalesce(
            max(refreshed_at),
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
        ) AS last_refreshed_at,
        {% if is_incremental() %}(count() = 0){% else %}1{% endif %} AS is_empty
    FROM {% if is_incremental() %}{{ this }}{% else %}(SELECT CAST(null, 'Nullable(DateTime64(9, ''UTC''))') AS refreshed_at){% endif %}
),

activity_summary_dirty_keys AS (
    SELECT
        activity_summary.activity_id AS activity_id,
        activity_summary.user_id AS user_id
    FROM activity_summary
    CROSS JOIN target_state
    WHERE target_state.is_empty
        OR activity_summary.refreshed_at > target_state.last_refreshed_at
),

{% if is_incremental() %}
existing_hiking_activity AS (
    SELECT
        activity_id,
        user_id,
        canonical_type,
        activity_name,
        started_at,
        ended_at,
        distance_m,
        duration_seconds,
        average_pace_min_per_km,
        elevation_gain_m,
        elevation_loss_m,
        average_grade_percent,
        avg_heart_rate
    FROM {{ this }} FINAL
    WHERE is_deleted = 0
),
{% endif %}

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
),

active_rows AS (
    SELECT
        activity_summary.activity_id AS activity_id,
        activity_summary.user_id AS user_id,
        activity_summary.canonical_type AS canonical_type,
        activity_summary.name AS activity_name,
        activity_summary.started_at AS started_at,
        activity_summary.ended_at AS ended_at,
        round(activity_summary.distance_m, 1) AS distance_m,
        if(
            activity_summary.ended_at IS NOT null,
            toFloat64(dateDiff('second', activity_summary.started_at, activity_summary.ended_at)),
            0
        ) AS duration_seconds,
        if(
            activity_summary.distance_m > 0 AND activity_summary.ended_at IS NOT null,
            round(
                (
                    dateDiff('second', activity_summary.started_at, activity_summary.ended_at) / 60.0
                ) / (activity_summary.distance_m / 1000.0),
                2
            ),
            0
        ) AS average_pace_min_per_km,
        round(activity_summary.elevation_gain_m, 1) AS elevation_gain_m,
        round(activity_summary.elevation_loss_m, 1) AS elevation_loss_m,
        if(
            activity_summary.distance_m > 0,
            round(
                (
                    activity_summary.elevation_gain_m - activity_summary.elevation_loss_m
                ) / activity_summary.distance_m * 100,
                4
            ),
            0
        ) AS average_grade_percent,
        round(activity_summary.avg_hr, 1) AS avg_heart_rate,
        0 AS is_deleted,
        refresh_clock.refresh_version AS refresh_version,
        refresh_clock.refreshed_at AS refreshed_at
    FROM activity_summary
    INNER JOIN activity_summary_dirty_keys
        ON activity_summary_dirty_keys.activity_id = activity_summary.activity_id
        AND activity_summary_dirty_keys.user_id = activity_summary.user_id
    CROSS JOIN refresh_clock
)

{% if is_incremental() %}
,

tombstone_rows AS (
    SELECT
        existing_hiking_activity.activity_id AS activity_id,
        existing_hiking_activity.user_id AS user_id,
        existing_hiking_activity.canonical_type AS canonical_type,
        existing_hiking_activity.activity_name AS activity_name,
        existing_hiking_activity.started_at AS started_at,
        existing_hiking_activity.ended_at AS ended_at,
        existing_hiking_activity.distance_m AS distance_m,
        existing_hiking_activity.duration_seconds AS duration_seconds,
        existing_hiking_activity.average_pace_min_per_km AS average_pace_min_per_km,
        existing_hiking_activity.elevation_gain_m AS elevation_gain_m,
        existing_hiking_activity.elevation_loss_m AS elevation_loss_m,
        existing_hiking_activity.average_grade_percent AS average_grade_percent,
        existing_hiking_activity.avg_heart_rate AS avg_heart_rate,
        1 AS is_deleted,
        refresh_clock.refresh_version AS refresh_version,
        refresh_clock.refreshed_at AS refreshed_at
    FROM existing_hiking_activity
    LEFT JOIN activity_summary
        ON activity_summary.activity_id = existing_hiking_activity.activity_id
        AND activity_summary.user_id = existing_hiking_activity.user_id
    CROSS JOIN refresh_clock
    WHERE activity_summary.activity_id IS NULL
)
{% endif %}

SELECT
    activity_id,
    user_id,
    canonical_type,
    activity_name,
    started_at,
    ended_at,
    distance_m,
    duration_seconds,
    average_pace_min_per_km,
    elevation_gain_m,
    elevation_loss_m,
    average_grade_percent,
    avg_heart_rate,
    is_deleted,
    refresh_version,
    refreshed_at
FROM active_rows
{% if is_incremental() %}
UNION ALL
SELECT
    activity_id,
    user_id,
    canonical_type,
    activity_name,
    started_at,
    ended_at,
    distance_m,
    duration_seconds,
    average_pace_min_per_km,
    elevation_gain_m,
    elevation_loss_m,
    average_grade_percent,
    avg_heart_rate,
    is_deleted,
    refresh_version,
    refreshed_at
FROM tombstone_rows
{% endif %}
