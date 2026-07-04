{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH target_state AS (
    SELECT
        {% if is_incremental() %}
            fromUnixTimestamp64Nano(toInt64(coalesce(max(refresh_version), 0))) AS last_refreshed_at,
            count() = 0 AS is_empty
        FROM {{ this }}
        {% else %}
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC') AS last_refreshed_at,
            true AS is_empty
        {% endif %}
),

current_activity AS (
    SELECT
        activity_id,
        user_id,
        started_at
    FROM {{ ref('deduped_activities') }} FINAL
    WHERE is_deleted = 0
),

initial_dirty_keys AS (
    SELECT
        activity_id,
        user_id
    FROM current_activity
    WHERE (SELECT is_empty FROM target_state)
),

sample_dirty_keys AS (
    SELECT DISTINCT
        activity_id,
        user_id
    FROM {{ ref('activity_sensor_sample') }}
    WHERE NOT (SELECT is_empty FROM target_state)
        AND refreshed_at > (SELECT last_refreshed_at FROM target_state)
),

location_dirty_keys AS (
    SELECT DISTINCT
        activity_id,
        user_id
    FROM {{ ref('activity_location_sample') }}
    WHERE NOT (SELECT is_empty FROM target_state)
        AND refreshed_at > (SELECT last_refreshed_at FROM target_state)
),

dirty_keys AS (
    SELECT DISTINCT
        activity_id,
        user_id
    FROM (
        SELECT
            activity_id,
            user_id
        FROM initial_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM sample_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM location_dirty_keys
    )
),

active_dirty_keys AS (
    SELECT
        dirty_keys.activity_id AS activity_id,
        dirty_keys.user_id AS user_id
    FROM dirty_keys
    INNER JOIN current_activity
        ON current_activity.activity_id = dirty_keys.activity_id
        AND current_activity.user_id = dirty_keys.user_id
),

scalar_samples AS (
    SELECT
        sensor_samples.activity_id AS activity_id,
        sensor_samples.user_id AS user_id,
        sensor_samples.recorded_at AS recorded_at,
        sensor_samples.channel AS channel,
        sensor_samples.scalar AS scalar
    FROM {{ ref('activity_sensor_sample') }} AS sensor_samples
    WHERE sensor_samples.is_deleted = 0
        AND sensor_samples.scalar IS NOT null
        AND sensor_samples.channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude')
        AND (sensor_samples.user_id, sensor_samples.activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM active_dirty_keys
        )
),

scalar_points AS (
    SELECT
        user_id,
        activity_id,
        recorded_at,
        CAST(maxIf(scalar, channel = 'heart_rate'), 'Nullable(Float64)') AS heart_rate,
        CAST(maxIf(scalar, channel = 'power'), 'Nullable(Float64)') AS power,
        CAST(maxIf(scalar, channel = 'speed'), 'Nullable(Float64)') AS speed,
        CAST(maxIf(scalar, channel = 'cadence'), 'Nullable(Float64)') AS cadence,
        CAST(maxIf(scalar, channel = 'altitude'), 'Nullable(Float64)') AS altitude
    FROM scalar_samples
    GROUP BY user_id, activity_id, recorded_at
),

location_points AS (
    SELECT
        location_samples.activity_id AS activity_id,
        location_samples.user_id AS user_id,
        location_samples.recorded_at AS recorded_at,
        CAST(any(location_samples.lat), 'Nullable(Float64)') AS lat,
        CAST(any(location_samples.lng), 'Nullable(Float64)') AS lng
    FROM {{ ref('activity_location_sample') }} AS location_samples
    WHERE location_samples.is_deleted = 0
        AND location_samples.lat IS NOT null
        AND location_samples.lng IS NOT null
        AND (location_samples.user_id, location_samples.activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM active_dirty_keys
        )
    GROUP BY user_id, activity_id, recorded_at
),

combined_sample_times AS (
    SELECT
        user_id,
        activity_id,
        recorded_at
    FROM scalar_points
    UNION DISTINCT
    SELECT
        user_id,
        activity_id,
        recorded_at
    FROM location_points
),

sample_times AS (
    SELECT
        user_id,
        activity_id,
        recorded_at
    FROM combined_sample_times
),

point_rows AS (
    SELECT
        sample_times.user_id AS user_id,
        sample_times.activity_id AS activity_id,
        sample_times.recorded_at AS recorded_at,
        scalar_points.heart_rate AS heart_rate,
        scalar_points.power AS power,
        scalar_points.speed AS speed,
        scalar_points.cadence AS cadence,
        scalar_points.altitude AS altitude,
        location_points.lat AS lat,
        location_points.lng AS lng
    FROM sample_times
    LEFT JOIN scalar_points
        ON scalar_points.user_id = sample_times.user_id
        AND scalar_points.activity_id = sample_times.activity_id
        AND scalar_points.recorded_at = sample_times.recorded_at
    LEFT JOIN location_points
        ON location_points.user_id = sample_times.user_id
        AND location_points.activity_id = sample_times.activity_id
        AND location_points.recorded_at = sample_times.recorded_at
),

points_by_activity AS (
    SELECT
        user_id,
        activity_id,
        arraySort(
            point -> point.1,
            groupArray(tuple(
                recorded_at,
                heart_rate,
                power,
                speed,
                cadence,
                altitude,
                lat,
                lng
            ))
        ) AS points
    FROM point_rows
    GROUP BY user_id, activity_id
),

refresh_clock AS (
    SELECT toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version
)

SELECT
    points_by_activity.user_id AS user_id,
    points_by_activity.activity_id AS activity_id,
    points_by_activity.points AS points,
    refresh_clock.refresh_version AS refresh_version
FROM points_by_activity
CROSS JOIN refresh_clock
WHERE length(points_by_activity.points) > 0
