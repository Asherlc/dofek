{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

{% set initial_lookback_days = var('initial_lookback_days', 120) %}
{% set activity_refresh_scoped = activity_refresh_scope_enabled() %}

WITH
{% if is_incremental() %}
target_state AS (
    SELECT count() = 0 AS is_empty
    FROM {{ this }}
),
{% endif %}

current_activity AS (
    SELECT
        activity_id,
        user_id,
        started_at
    FROM {{ ref('deduped_activities') }} FINAL
    WHERE is_deleted = 0
),

existing_summary_state AS (
    {% if is_incremental() %}
        SELECT
            activity_id,
            user_id,
            max(refresh_version) AS summary_refresh_version,
            argMax(is_deleted, refresh_version) AS is_deleted
        FROM {{ this }}
        GROUP BY activity_id, user_id
    {% else %}
        SELECT
            CAST(null, 'Nullable(UUID)') AS activity_id,
            CAST(null, 'Nullable(UUID)') AS user_id,
            CAST(null, 'Nullable(UInt64)') AS summary_refresh_version,
            CAST(null, 'Nullable(UInt8)') AS is_deleted
        WHERE 1 = 0
    {% endif %}
),

existing_summary AS (
    SELECT
        activity_id,
        user_id,
        summary_refresh_version
    FROM existing_summary_state
    WHERE is_deleted = 0
),

location_source_versions AS MATERIALIZED (
    SELECT
        activity_id,
        user_id,
        max(refresh_version) AS refresh_version
    FROM {{ ref('activity_location_sample') }}
    GROUP BY activity_id, user_id
),

{% if activity_refresh_scoped %}
repair_scope_dirty_keys AS (
    SELECT
        deduped.activity_id,
        deduped.user_id
    FROM {{ ref('deduped_activities') }} AS deduped FINAL
    WHERE deduped.user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND (
            deduped.activity_id IN {{ activity_refresh_ids() }}
            OR hasAny(deduped.member_activity_ids, {{ activity_refresh_ids() }})
        )

    UNION DISTINCT

    SELECT
        activity_id,
        user_id
    FROM existing_summary
    WHERE user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND activity_id IN {{ activity_refresh_ids() }}
),
{% endif %}

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
    {% if is_incremental() %}
    SELECT DISTINCT
        location_source_versions.activity_id AS activity_id,
        location_source_versions.user_id AS user_id
    FROM location_source_versions
    LEFT JOIN existing_summary_state
        ON existing_summary_state.activity_id = location_source_versions.activity_id
        AND existing_summary_state.user_id = location_source_versions.user_id
    WHERE NOT (SELECT is_empty FROM target_state)
        AND (
            existing_summary_state.activity_id IS null
            OR location_source_versions.refresh_version
                > existing_summary_state.summary_refresh_version
        )
    {% else %}
    SELECT CAST(null, 'Nullable(UUID)') AS activity_id,
        CAST(null, 'Nullable(UUID)') AS user_id
    WHERE 1 = 0
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
        {% if activity_refresh_scoped %}
        SELECT
            activity_id,
            user_id
        FROM repair_scope_dirty_keys
        {% else %}
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
        {% endif %}
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

affected_location_sample_keys AS (
    SELECT DISTINCT
        location_samples.user_id AS user_id,
        location_samples.activity_id AS activity_id,
        location_samples.source_metric_stream_id AS source_metric_stream_id
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
        WHERE (user_id, activity_id, source_metric_stream_id) IN (
            SELECT user_id, activity_id, source_metric_stream_id
            FROM affected_location_sample_keys
        )
        ORDER BY
            user_id ASC,
            activity_id ASC,
            source_metric_stream_id ASC,
            refresh_version DESC,
            is_deleted DESC
        LIMIT 1 BY user_id, activity_id, source_metric_stream_id
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
