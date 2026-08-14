{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1
    }
) }}

{% set initial_lookback_days = var('initial_lookback_days', 120) %}

WITH
{% if is_incremental() %}
target_state AS (
    SELECT
        coalesce(
            max(refreshed_at),
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
        ) AS last_refreshed_at,
        count() = 0 AS is_empty
    FROM {{ this }}
),
{% endif %}

current_activity AS (
    SELECT
        id AS activity_id,
        user_id,
        started_at
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    WHERE _peerdb_is_deleted = 0
        AND provider_absent_at IS null
        AND deleted_at IS null
),

existing_summary AS (
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
    WHERE
        {% if is_incremental() %}
            (SELECT is_empty FROM target_state)
            AND started_at >= now64(6, 'UTC') - INTERVAL {{ initial_lookback_days }} DAY
        {% else %}
            started_at >= now64(6, 'UTC') - INTERVAL {{ initial_lookback_days }} DAY
        {% endif %}
),

location_dirty_keys AS (
    SELECT DISTINCT
        activity_id,
        user_id
    FROM {{ ref('activity_location_sample') }}
    WHERE
        {% if is_incremental() %}
            NOT (SELECT is_empty FROM target_state)
            AND refreshed_at > (SELECT last_refreshed_at FROM target_state)
        {% else %}
            1 = 0
        {% endif %}
),

stale_dirty_keys AS (
    SELECT
        existing_summary.activity_id AS activity_id,
        existing_summary.user_id AS user_id
    FROM existing_summary
    LEFT JOIN current_activity
        ON current_activity.activity_id = existing_summary.activity_id
    WHERE current_activity.activity_id IS null
),

restored_dirty_keys AS (
    {% if is_incremental() %}
        SELECT
            tombstoned_summary.activity_id AS activity_id,
            tombstoned_summary.user_id AS user_id
        FROM (
            SELECT
                activity_id,
                user_id
            FROM {{ this }} FINAL
            WHERE is_deleted = 1
        ) AS tombstoned_summary
        INNER JOIN current_activity
            ON current_activity.activity_id = tombstoned_summary.activity_id
            AND current_activity.user_id = tombstoned_summary.user_id
        WHERE EXISTS (
            SELECT 1
            FROM {{ this }} AS prior_summary FINAL
            WHERE prior_summary.activity_id = tombstoned_summary.activity_id
                AND prior_summary.user_id = tombstoned_summary.user_id
                AND prior_summary.is_deleted = 0
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
),

active_dirty_keys AS (
    SELECT
        assumeNotNull(activity_id) AS activity_id,
        assumeNotNull(user_id) AS user_id
    FROM dirty_keys
    WHERE activity_id IS NOT null
        AND user_id IS NOT null
),

current_dirty_keys AS (
    SELECT
        active_dirty_keys.activity_id AS activity_id,
        active_dirty_keys.user_id AS user_id
    FROM active_dirty_keys
    INNER JOIN current_activity
        ON current_activity.activity_id = active_dirty_keys.activity_id
        AND current_activity.user_id = active_dirty_keys.user_id
),

affected_location_sample_ids AS (
    SELECT DISTINCT location_samples.source_metric_stream_id AS source_metric_stream_id
    FROM {{ ref('activity_location_sample') }} AS location_samples
    INNER JOIN current_dirty_keys
        ON current_dirty_keys.activity_id = location_samples.activity_id
        AND current_dirty_keys.user_id = location_samples.user_id
),

latest_location_samples AS (
    SELECT *
    FROM (
        SELECT *
        FROM {{ ref('activity_location_sample') }}
        WHERE source_metric_stream_id IN (
            SELECT source_metric_stream_id
            FROM affected_location_sample_ids
        )
        ORDER BY
            source_metric_stream_id ASC,
            refresh_version DESC
        LIMIT 1 BY source_metric_stream_id
    )
    WHERE is_deleted = 0
),

gps_points AS (
    SELECT
        activity_id,
        user_id,
        recorded_at,
        lat,
        lng
    FROM latest_location_samples
    WHERE lat IS NOT null
        AND lng IS NOT null
),

gps_deltas AS (
    SELECT
        activity_id,
        lat,
        lng,
        lagInFrame(lat) OVER (
            PARTITION BY activity_id
            ORDER BY recorded_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS prev_lat,
        lagInFrame(lng) OVER (
            PARTITION BY activity_id
            ORDER BY recorded_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS prev_lng
    FROM gps_points
),

distance_per_activity AS (
    SELECT
        activity_id,
        CAST(sum(
            2 * 6371000 * asin(sqrt(
                pow(sin(radians(lat - prev_lat) / 2), 2)
                + cos(radians(prev_lat)) * cos(radians(lat))
                * pow(sin(radians(lng - prev_lng) / 2), 2)
            ))
        ), 'Nullable(Float64)') AS total_distance
    FROM gps_deltas
    WHERE prev_lat IS NOT null
    GROUP BY activity_id
),

location_centroids AS (
    SELECT
        activity_id,
        user_id,
        CAST(avg(lat), 'Nullable(Float64)') AS centroid_lat,
        CAST(avg(lng), 'Nullable(Float64)') AS centroid_lng
    FROM gps_points
    GROUP BY activity_id, user_id
)

SELECT
    assumeNotNull(dirty_keys.activity_id) AS activity_id,
    assumeNotNull(dirty_keys.user_id) AS user_id,
    distance_per_activity.total_distance AS total_distance,
    location_centroids.centroid_lat AS centroid_lat,
    location_centroids.centroid_lng AS centroid_lng,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    if(location_centroids.activity_id IS null, 1, 0) AS is_deleted,
    now64(9) AS refreshed_at
FROM dirty_keys
LEFT JOIN distance_per_activity
    ON distance_per_activity.activity_id = dirty_keys.activity_id
LEFT JOIN location_centroids
    ON location_centroids.activity_id = dirty_keys.activity_id
    AND location_centroids.user_id = dirty_keys.user_id
