{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(_peerdb_version)',
    order_by='(user_id, channel, recorded_date, recorded_at, provider_priority, provider_id, id)'
) }}

{% set initial_lookback_days = var('initial_lookback_days', 120) %}

WITH target_state AS (
    SELECT
        {% if is_incremental() %}
            coalesce(
                max(_peerdb_synced_at),
                toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
            ) AS last_synced_at,
            count() = 0 AS is_empty
        FROM {{ this }}
        {% else %}
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC') AS last_synced_at,
            true AS is_empty
        {% endif %}
),

metric_stream_rows AS (
    SELECT *
    FROM {{ source('postgres_fitness', 'metric_stream') }} FINAL
    WHERE scalar IS NOT NULL
        AND channel IN (
            'heart_rate',
            'power',
            'speed',
            'cadence',
            'altitude',
            'grade',
            'left_right_balance',
            'left_torque_effectiveness',
            'right_torque_effectiveness',
            'left_pedal_smoothness',
            'right_pedal_smoothness',
            'stance_time',
            'vertical_oscillation',
            'ground_contact_time',
            'stride_length'
        )
        {% if is_incremental() %}
            AND (
                (
                    (SELECT is_empty FROM target_state)
                    AND recorded_at >= now64(6, 'UTC') - INTERVAL {{ initial_lookback_days }} DAY
                )
                OR (
                    NOT (SELECT is_empty FROM target_state)
                    AND _peerdb_synced_at > (SELECT last_synced_at FROM target_state)
                )
            )
        {% else %}
            AND recorded_at >= now64(6, 'UTC') - INTERVAL {{ initial_lookback_days }} DAY
        {% endif %}
),

active_sensor_provider_priority AS (
    SELECT
        provider_id,
        channel,
        priority
    FROM {{ source('postgres_fitness', 'sensor_provider_priority') }} FINAL
    WHERE _peerdb_is_deleted = 0
),

active_sensor_device_priority AS (
    SELECT
        provider_id,
        source_name_pattern,
        channel,
        priority
    FROM {{ source('postgres_fitness', 'sensor_device_priority') }} FINAL
    WHERE _peerdb_is_deleted = 0
),

device_priority_match AS (
    SELECT
        metric_stream_id,
        priority
    FROM (
        SELECT
            metric_stream_rows.id AS metric_stream_id,
            active_sensor_device_priority.priority AS priority,
            row_number() OVER (
                PARTITION BY metric_stream_rows.id
                ORDER BY
                    length(active_sensor_device_priority.source_name_pattern) DESC,
                    active_sensor_device_priority.priority ASC,
                    active_sensor_device_priority.source_name_pattern ASC
            ) AS row_number
        FROM metric_stream_rows
        INNER JOIN active_sensor_device_priority
            ON active_sensor_device_priority.provider_id = metric_stream_rows.provider_id
            AND active_sensor_device_priority.channel = metric_stream_rows.channel
            AND metric_stream_rows.device_id IS NOT NULL
            AND assumeNotNull(metric_stream_rows.device_id)
            LIKE active_sensor_device_priority.source_name_pattern
    )
    WHERE row_number = 1
)

SELECT
    metric_stream_rows.id AS id,
    metric_stream_rows.user_id AS user_id,
    metric_stream_rows.recorded_at AS recorded_at,
    toDate(metric_stream_rows.recorded_at) AS recorded_date,
    metric_stream_rows.channel AS channel,
    metric_stream_rows.provider_id AS provider_id,
    metric_stream_rows.device_id AS device_id,
    assumeNotNull(metric_stream_rows.scalar) AS scalar,
    coalesce(
        device_priority_match.priority,
        active_sensor_provider_priority.priority,
        1000
    ) AS provider_priority,
    metric_stream_rows._peerdb_synced_at AS _peerdb_synced_at,
    metric_stream_rows._peerdb_is_deleted AS _peerdb_is_deleted,
    metric_stream_rows._peerdb_version AS _peerdb_version
FROM metric_stream_rows
LEFT JOIN active_sensor_provider_priority
    ON active_sensor_provider_priority.provider_id = metric_stream_rows.provider_id
    AND active_sensor_provider_priority.channel = metric_stream_rows.channel
LEFT JOIN device_priority_match
    ON device_priority_match.metric_stream_id = metric_stream_rows.id
