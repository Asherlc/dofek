{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)'
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
        activity_type,
        name,
        started_at,
        ended_at
    FROM analytics.v_activity
),

existing_activity_summary AS (
    {% if is_incremental() %}
        SELECT *
        FROM {{ this }} FINAL
    {% else %}
        SELECT
            CAST(null, 'Nullable(UUID)') AS activity_id,
            CAST(null, 'Nullable(UUID)') AS user_id,
            CAST(null, 'Nullable(String)') AS activity_type,
            CAST(null, 'Nullable(String)') AS name,
            CAST(null, 'Nullable(DateTime64(6, ''UTC''))') AS started_at,
            CAST(null, 'Nullable(DateTime64(6, ''UTC''))') AS ended_at
        WHERE 1 = 0
    {% endif %}
),

initial_activity_dirty_keys AS (
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

changed_raw_activity AS (
    SELECT
        id,
        user_id,
        started_at,
        coalesce(ended_at, started_at + INTERVAL 12 HOUR) AS ended_at
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    WHERE
        {% if is_incremental() %}
            NOT (SELECT is_empty FROM target_state)
            AND _peerdb_synced_at > (SELECT last_refreshed_at FROM target_state)
        {% else %}
            1 = 0
        {% endif %}
),

activity_source_dirty_keys AS (
    SELECT DISTINCT
        current_activity.activity_id AS activity_id,
        current_activity.user_id AS user_id
    FROM changed_raw_activity
    INNER JOIN current_activity
        ON current_activity.user_id = changed_raw_activity.user_id
        AND current_activity.started_at <= changed_raw_activity.ended_at
        AND coalesce(
            current_activity.ended_at,
            current_activity.started_at + INTERVAL 12 HOUR
        ) >= changed_raw_activity.started_at
),

sensor_dirty_keys AS (
    SELECT DISTINCT
        current_activity.activity_id AS activity_id,
        current_activity.user_id AS user_id
    FROM {{ ref('deduped_sensor') }} AS samples FINAL
    INNER JOIN current_activity
        ON current_activity.user_id = samples.user_id
        AND samples.recorded_at >= current_activity.started_at
        AND samples.recorded_at <= coalesce(
            current_activity.ended_at,
            current_activity.started_at + INTERVAL 12 HOUR
        )
    WHERE
        {% if is_incremental() %}
            NOT (SELECT is_empty FROM target_state)
            AND samples.refreshed_at > (SELECT last_refreshed_at FROM target_state)
        {% else %}
            1 = 0
        {% endif %}
),

location_dirty_keys AS (
    SELECT DISTINCT
        activity_members.activity_id AS activity_id,
        activity_members.user_id AS user_id
    FROM (
        SELECT *
        FROM {{ source('postgres_fitness', 'metric_stream') }} FINAL
    ) AS metric_stream
    INNER JOIN analytics.v_activity_members AS activity_members
        ON activity_members.member_activity_id = metric_stream.activity_id
    WHERE
        {% if is_incremental() %}
            NOT (SELECT is_empty FROM target_state)
            AND metric_stream._peerdb_synced_at > (
                SELECT last_refreshed_at FROM target_state
            )
        {% else %}
            1 = 0
        {% endif %}
        AND metric_stream.channel = 'location'
        AND metric_stream.point IS NOT null
),

stale_activity_dirty_keys AS (
    SELECT
        existing_activity_summary.activity_id AS activity_id,
        existing_activity_summary.user_id AS user_id
    FROM existing_activity_summary
    LEFT JOIN current_activity
        ON current_activity.activity_id = existing_activity_summary.activity_id
    WHERE current_activity.activity_id IS null
),

dirty_keys AS (
    SELECT DISTINCT
        activity_id,
        user_id
    FROM (
        SELECT
            activity_id,
            user_id
        FROM initial_activity_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM activity_source_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM sensor_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM location_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM stale_activity_dirty_keys
    )
),

activity_bounds AS (
    SELECT
        current_activity.activity_id AS activity_id,
        current_activity.user_id AS user_id,
        current_activity.activity_type AS activity_type,
        current_activity.name AS name,
        current_activity.started_at AS started_at,
        current_activity.ended_at AS ended_at
    FROM current_activity
    INNER JOIN dirty_keys
        ON dirty_keys.activity_id = current_activity.activity_id
),

deduped_samples AS (
    SELECT
        activity_bounds.activity_id AS activity_id,
        samples.user_id AS user_id,
        samples.recorded_at AS recorded_at,
        samples.channel AS channel,
        samples.scalar AS scalar
    FROM activity_bounds
    INNER JOIN {{ ref('deduped_sensor') }} AS samples FINAL
        ON samples.user_id = activity_bounds.user_id
        AND samples.recorded_at >= activity_bounds.started_at
        AND samples.recorded_at <= coalesce(
            activity_bounds.ended_at,
            activity_bounds.started_at + INTERVAL 12 HOUR
        )
    WHERE samples.is_deleted = 0
        AND samples.scalar IS NOT null
),

altitude_deltas AS (
    SELECT
        activity_id,
        scalar AS altitude,
        lagInFrame(scalar) OVER (
            PARTITION BY activity_id
            ORDER BY recorded_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS prev_altitude
    FROM deduped_samples
    WHERE channel = 'altitude'
),

elevation_per_activity AS (
    SELECT
        activity_id,
        CAST(
            sum(if(altitude - prev_altitude > 0, altitude - prev_altitude, 0)),
            'Nullable(Float64)'
        ) AS elevation_gain_m,
        CAST(
            sum(if(altitude - prev_altitude < 0, abs(altitude - prev_altitude), 0)),
            'Nullable(Float64)'
        ) AS elevation_loss_m
    FROM altitude_deltas
    WHERE prev_altitude IS NOT null
    GROUP BY activity_id
),

gps_points AS (
    SELECT
        deduped_location.activity_id AS activity_id,
        deduped_location.recorded_at AS recorded_at,
        deduped_location.lat AS lat,
        deduped_location.lng AS lng
    FROM analytics.deduped_location AS deduped_location
    INNER JOIN dirty_keys
        ON dirty_keys.activity_id = deduped_location.activity_id
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
        CAST(avg(lat), 'Nullable(Float64)') AS centroid_lat,
        CAST(avg(lng), 'Nullable(Float64)') AS centroid_lng
    FROM gps_points
    WHERE lat IS NOT null
        AND lng IS NOT null
    GROUP BY activity_id
),

channel_aggs AS (
    SELECT
        activity_id,
        user_id,
        CAST(avgIf(scalar, channel = 'heart_rate'), 'Nullable(Float64)') AS avg_hr,
        CAST(maxIf(scalar, channel = 'heart_rate'), 'Nullable(Int16)') AS max_hr,
        CAST(minIf(scalar, channel = 'heart_rate'), 'Nullable(Int16)') AS min_hr,
        CAST(avgIf(scalar, channel = 'power' AND scalar > 0), 'Nullable(Float64)') AS avg_power,
        CAST(maxIf(scalar, channel = 'power' AND scalar > 0), 'Nullable(Int16)') AS max_power,
        CAST(avgIf(scalar, channel = 'speed'), 'Nullable(Float64)') AS avg_speed,
        CAST(maxIf(scalar, channel = 'speed'), 'Nullable(Float64)') AS max_speed,
        CAST(avgIf(scalar, channel = 'cadence' AND scalar > 0), 'Nullable(Float64)') AS avg_cadence,
        CAST(maxIf(scalar, channel = 'altitude'), 'Nullable(Float64)') AS max_altitude,
        CAST(minIf(scalar, channel = 'altitude'), 'Nullable(Float64)') AS min_altitude,
        CAST(avgIf(scalar, channel = 'left_right_balance'), 'Nullable(Float64)') AS avg_left_balance,
        CAST(
            avgIf(scalar, channel = 'left_torque_effectiveness'),
            'Nullable(Float64)'
        ) AS avg_left_torque_eff,
        CAST(
            avgIf(scalar, channel = 'right_torque_effectiveness'),
            'Nullable(Float64)'
        ) AS avg_right_torque_eff,
        CAST(
            avgIf(scalar, channel = 'left_pedal_smoothness'),
            'Nullable(Float64)'
        ) AS avg_left_pedal_smooth,
        CAST(
            avgIf(scalar, channel = 'right_pedal_smoothness'),
            'Nullable(Float64)'
        ) AS avg_right_pedal_smooth,
        CAST(avgIf(scalar, channel = 'stance_time'), 'Nullable(Float64)') AS avg_stance_time,
        CAST(
            avgIf(scalar, channel = 'vertical_oscillation'),
            'Nullable(Float64)'
        ) AS avg_vertical_osc,
        CAST(
            avgIf(scalar, channel = 'ground_contact_time'),
            'Nullable(Float64)'
        ) AS avg_ground_contact_time,
        CAST(avgIf(scalar, channel = 'stride_length'), 'Nullable(Float64)') AS avg_stride_length,
        count() AS sample_count,
        countIf(channel = 'heart_rate') AS hr_sample_count,
        countIf(channel = 'power' AND scalar > 0) AS power_sample_count,
        min(recorded_at) AS first_sample_at,
        max(recorded_at) AS last_sample_at
    FROM deduped_samples
    GROUP BY activity_id, user_id
)

SELECT
    assumeNotNull(dirty_keys.activity_id) AS activity_id,
    assumeNotNull(dirty_keys.user_id) AS user_id,
    CAST(
        coalesce(activity_bounds.activity_type, existing_activity_summary.activity_type),
        'Nullable(String)'
    ) AS activity_type,
    CAST(
        coalesce(activity_bounds.name, existing_activity_summary.name),
        'Nullable(String)'
    ) AS name,
    CAST(
        coalesce(activity_bounds.started_at, existing_activity_summary.started_at),
        'Nullable(DateTime64(6, ''UTC''))'
    ) AS started_at,
    CAST(
        coalesce(activity_bounds.ended_at, existing_activity_summary.ended_at),
        'Nullable(DateTime64(6, ''UTC''))'
    ) AS ended_at,
    channel_aggs.avg_hr AS avg_hr,
    channel_aggs.max_hr AS max_hr,
    channel_aggs.min_hr AS min_hr,
    channel_aggs.avg_power AS avg_power,
    channel_aggs.max_power AS max_power,
    if(activity_bounds.activity_type IN ('indoor_cycling', 'virtual_cycling'), null, channel_aggs.avg_speed) AS avg_speed,
    if(activity_bounds.activity_type IN ('indoor_cycling', 'virtual_cycling'), null, channel_aggs.max_speed) AS max_speed,
    channel_aggs.avg_cadence AS avg_cadence,
    if(
        channel_aggs.max_altitude IS NOT null AND channel_aggs.min_altitude IS NOT null,
        channel_aggs.max_altitude - channel_aggs.min_altitude,
        null
    ) AS elevation_gain_legacy,
    if(
        activity_bounds.activity_type IN ('indoor_cycling', 'virtual_cycling'),
        CAST(0, 'Nullable(Float64)'),
        coalesce(distance_per_activity.total_distance, CAST(0, 'Nullable(Float64)'))
    ) AS total_distance,
    location_centroids.centroid_lat AS centroid_lat,
    location_centroids.centroid_lng AS centroid_lng,
    channel_aggs.avg_left_balance AS avg_left_balance,
    channel_aggs.avg_left_torque_eff AS avg_left_torque_eff,
    channel_aggs.avg_right_torque_eff AS avg_right_torque_eff,
    channel_aggs.avg_left_pedal_smooth AS avg_left_pedal_smooth,
    channel_aggs.avg_right_pedal_smooth AS avg_right_pedal_smooth,
    coalesce(elevation_per_activity.elevation_gain_m, CAST(0, 'Nullable(Float64)')) AS elevation_gain_m,
    coalesce(elevation_per_activity.elevation_loss_m, CAST(0, 'Nullable(Float64)')) AS elevation_loss_m,
    channel_aggs.avg_stance_time AS avg_stance_time,
    channel_aggs.avg_vertical_osc AS avg_vertical_osc,
    channel_aggs.avg_ground_contact_time AS avg_ground_contact_time,
    channel_aggs.avg_stride_length AS avg_stride_length,
    channel_aggs.sample_count AS sample_count,
    channel_aggs.hr_sample_count AS hr_sample_count,
    channel_aggs.power_sample_count AS power_sample_count,
    channel_aggs.first_sample_at AS first_sample_at,
    channel_aggs.last_sample_at AS last_sample_at,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    if(activity_bounds.activity_id IS null, 1, 0) AS is_deleted,
    now64(9) AS refreshed_at
FROM dirty_keys
LEFT JOIN activity_bounds
    ON activity_bounds.activity_id = dirty_keys.activity_id
LEFT JOIN existing_activity_summary
    ON existing_activity_summary.activity_id = dirty_keys.activity_id
LEFT JOIN channel_aggs
    ON channel_aggs.activity_id = dirty_keys.activity_id
LEFT JOIN elevation_per_activity
    ON elevation_per_activity.activity_id = dirty_keys.activity_id
LEFT JOIN distance_per_activity
    ON distance_per_activity.activity_id = dirty_keys.activity_id
LEFT JOIN location_centroids
    ON location_centroids.activity_id = dirty_keys.activity_id
