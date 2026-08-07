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

existing_stream_points AS (
    {% if is_incremental() %}
        SELECT
            activity_id,
            user_id
        FROM {{ this }} FINAL
        WHERE is_deleted = 0
    {% else %}
        SELECT
            CAST(null, 'Nullable(UUID)') AS activity_id,
            CAST(null, 'Nullable(UUID)') AS user_id
        WHERE 1 = 0
    {% endif %}
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

stale_dirty_keys AS (
    SELECT
        existing_stream_points.activity_id AS activity_id,
        existing_stream_points.user_id AS user_id
    FROM existing_stream_points
    LEFT JOIN current_activity
        ON current_activity.activity_id = existing_stream_points.activity_id
        AND current_activity.user_id = existing_stream_points.user_id
    WHERE current_activity.activity_id IS null
),

restored_dirty_keys AS (
    {% if is_incremental() %}
        SELECT
            tombstoned_stream_points.activity_id AS activity_id,
            tombstoned_stream_points.user_id AS user_id
        FROM (
            SELECT
                activity_id,
                user_id
            FROM {{ this }} FINAL
            WHERE is_deleted = 1
        ) AS tombstoned_stream_points
        INNER JOIN current_activity
            ON current_activity.activity_id = tombstoned_stream_points.activity_id
            AND current_activity.user_id = tombstoned_stream_points.user_id
        WHERE EXISTS (
            SELECT 1
            FROM {{ this }} AS prior_stream_points FINAL
            WHERE prior_stream_points.activity_id = tombstoned_stream_points.activity_id
                AND prior_stream_points.user_id = tombstoned_stream_points.user_id
                AND prior_stream_points.is_deleted = 0
        )
    {% else %}
        SELECT
            CAST(null, 'Nullable(UUID)') AS activity_id,
            CAST(null, 'Nullable(UUID)') AS user_id
        WHERE 1 = 0
    {% endif %}
),

dirty_keys AS (
    SELECT DISTINCT
        assumeNotNull(activity_id) AS activity_id,
        assumeNotNull(user_id) AS user_id
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
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM stale_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM restored_dirty_keys
    )
    WHERE activity_id IS NOT null
        AND user_id IS NOT null
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

latest_sensor_samples AS (
    SELECT *
    FROM (
        SELECT *
        FROM {{ ref('activity_sensor_sample') }}
        WHERE (user_id, activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM active_dirty_keys
        )
        ORDER BY
            user_id ASC,
            activity_id ASC,
            channel ASC,
            recorded_at ASC,
            refresh_version DESC
        LIMIT 1 BY user_id, activity_id, channel, recorded_at
    )
    WHERE is_deleted = 0
),

scalar_samples AS (
    SELECT
        activity_id,
        user_id,
        recorded_at,
        channel,
        scalar
    FROM latest_sensor_samples
    WHERE scalar IS NOT null
        AND channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude')
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

latest_location_samples AS (
    SELECT *
    FROM (
        SELECT *
        FROM {{ ref('activity_location_sample') }}
        WHERE (user_id, activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM active_dirty_keys
        )
        ORDER BY
            source_metric_stream_id ASC,
            refresh_version DESC
        LIMIT 1 BY source_metric_stream_id
    )
    WHERE is_deleted = 0
),

location_points AS (
    SELECT
        location_samples.activity_id,
        location_samples.user_id,
        location_samples.recorded_at,
        CAST(
            argMax(
                location_samples.lat,
                tuple(
                    location_samples.refresh_version,
                    location_samples.source_metric_stream_id
                )
            ),
            'Nullable(Float64)'
        ) AS lat,
        CAST(
            argMax(
                location_samples.lng,
                tuple(
                    location_samples.refresh_version,
                    location_samples.source_metric_stream_id
                )
            ),
            'Nullable(Float64)'
        ) AS lng
    FROM latest_location_samples AS location_samples
    WHERE location_samples.lat IS NOT null
        AND location_samples.lng IS NOT null
    GROUP BY
        location_samples.user_id,
        location_samples.activity_id,
        location_samples.recorded_at
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
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    dirty_keys.user_id AS user_id,
    dirty_keys.activity_id AS activity_id,
    if(
        points_by_activity.activity_id IS null,
        CAST([], 'Array(Tuple(DateTime64(6, ''UTC''), Nullable(Float64), Nullable(Float64), Nullable(Float64), Nullable(Float64), Nullable(Float64), Nullable(Float64), Nullable(Float64)))'),
        points_by_activity.points
    ) AS points,
    refresh_clock.refresh_version AS refresh_version,
    if(points_by_activity.activity_id IS null, 1, 0) AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM dirty_keys
CROSS JOIN refresh_clock
LEFT JOIN points_by_activity
    ON points_by_activity.activity_id = dirty_keys.activity_id
    AND points_by_activity.user_id = dirty_keys.user_id
