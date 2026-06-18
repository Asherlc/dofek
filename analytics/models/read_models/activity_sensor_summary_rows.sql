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

sample_dirty_keys AS (
    SELECT DISTINCT
        activity_id,
        user_id
    FROM {{ ref('activity_sensor_sample') }}
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
            FROM {{ this }} AS prior_summary
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
        FROM sample_dirty_keys
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

deduped_samples AS (
    SELECT
        sensor_samples.activity_id AS activity_id,
        sensor_samples.user_id AS user_id,
        sensor_samples.recorded_at AS recorded_at,
        sensor_samples.channel AS channel,
        sensor_samples.scalar AS scalar
    FROM {{ ref('activity_sensor_sample') }} AS sensor_samples
    WHERE sensor_samples.is_deleted = 0
        AND sensor_samples.scalar IS NOT null
        AND (sensor_samples.user_id, sensor_samples.activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM active_dirty_keys
        )
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
    channel_aggs.avg_hr AS avg_hr,
    channel_aggs.max_hr AS max_hr,
    channel_aggs.min_hr AS min_hr,
    channel_aggs.avg_power AS avg_power,
    channel_aggs.max_power AS max_power,
    channel_aggs.avg_speed AS avg_speed,
    channel_aggs.max_speed AS max_speed,
    channel_aggs.avg_cadence AS avg_cadence,
    if(
        channel_aggs.max_altitude IS NOT null AND channel_aggs.min_altitude IS NOT null,
        channel_aggs.max_altitude - channel_aggs.min_altitude,
        null
    ) AS elevation_gain_legacy,
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
    if(channel_aggs.activity_id IS null, 1, 0) AS is_deleted,
    now64(9) AS refreshed_at
FROM dirty_keys
LEFT JOIN channel_aggs
    ON channel_aggs.activity_id = dirty_keys.activity_id
    AND channel_aggs.user_id = dirty_keys.user_id
LEFT JOIN elevation_per_activity
    ON elevation_per_activity.activity_id = dirty_keys.activity_id
