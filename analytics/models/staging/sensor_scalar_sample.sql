{% set default_microbatch_begin = run_started_at.strftime('%Y-%m-%d') %}
{% set sensor_scalar_sample_begin = var('sensor_scalar_sample_begin', default_microbatch_begin) %}

{{ config(
    materialized='incremental',
    incremental_strategy='microbatch',
    unique_key='id',
    event_time='_peerdb_synced_at',
    begin=sensor_scalar_sample_begin,
    batch_size='day',
    lookback=3,
    full_refresh=false,
    concurrent_batches=false,
    on_schema_change='append_new_columns',
    engine='ReplacingMergeTree(_peerdb_version)',
    order_by='(user_id, channel, recorded_date, recorded_at, provider_id, id)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH metric_stream_versions AS (
    SELECT *
    FROM {{ source('ingest', 'metric_stream_freshness') }}
    WHERE (scalar IS NOT null OR is_deleted = 1)
        AND channel IN (
            'heart_rate',
            'power',
            'speed',
            'cadence',
            'altitude',
            'grade',
            'distance',
            'temperature',
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
),

metric_stream_latest AS (
    SELECT
        metric_stream_versions.id,
        argMax(
            tuple(
                metric_stream_versions.activity_id,
                metric_stream_versions.user_id,
                metric_stream_versions.recorded_at,
                metric_stream_versions.channel,
                metric_stream_versions.provider_id,
                metric_stream_versions.external_id,
                metric_stream_versions.device_id,
                metric_stream_versions.source_type,
                metric_stream_versions.metadata,
                metric_stream_versions.scalar,
                metric_stream_versions.ingested_at,
                metric_stream_versions.is_deleted,
                metric_stream_versions.version
            ),
            metric_stream_versions.version
        ) AS latest
    FROM metric_stream_versions
    GROUP BY metric_stream_versions.id
),

metric_stream_rows AS (
    SELECT
        metric_stream_latest.id AS id,
        tupleElement(metric_stream_latest.latest, 1) AS activity_id,
        tupleElement(metric_stream_latest.latest, 1) AS member_activity_id,
        tupleElement(metric_stream_latest.latest, 2) AS user_id,
        tupleElement(metric_stream_latest.latest, 3) AS recorded_at,
        tupleElement(metric_stream_latest.latest, 4) AS channel,
        tupleElement(metric_stream_latest.latest, 5) AS provider_id,
        tupleElement(metric_stream_latest.latest, 6) AS source_external_id,
        tupleElement(metric_stream_latest.latest, 7) AS device_id,
        tupleElement(metric_stream_latest.latest, 8) AS source_type,
        tupleElement(metric_stream_latest.latest, 9) AS metadata,
        coalesce(tupleElement(metric_stream_latest.latest, 10), 0) AS scalar,
        tupleElement(metric_stream_latest.latest, 11) AS ingested_at,
        tupleElement(metric_stream_latest.latest, 12) AS is_deleted,
        tupleElement(metric_stream_latest.latest, 13) AS source_version
    FROM metric_stream_latest
),

active_sensor_provider_priority AS (
    SELECT
        provider_id,
        channel,
        toNullable(priority) AS priority
    FROM {{ source('postgres_fitness', 'sensor_provider_priority') }} FINAL
    WHERE _peerdb_is_deleted = 0
),

active_sensor_device_priority AS (
    SELECT
        provider_id,
        source_name_pattern,
        channel,
        toNullable(priority) AS priority
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
            AND metric_stream_rows.device_id IS NOT null
            AND assumeNotNull(metric_stream_rows.device_id)
            LIKE active_sensor_device_priority.source_name_pattern
    )
    WHERE row_number = 1
)

SELECT
    metric_stream_rows.id AS id,
    metric_stream_rows.activity_id AS activity_id,
    metric_stream_rows.member_activity_id AS member_activity_id,
    metric_stream_rows.user_id AS user_id,
    metric_stream_rows.recorded_at AS recorded_at,
    toDate(metric_stream_rows.recorded_at) AS recorded_date,
    metric_stream_rows.channel AS channel,
    metric_stream_rows.provider_id AS provider_id,
    metric_stream_rows.source_external_id AS source_external_id,
    metric_stream_rows.device_id AS device_id,
    metric_stream_rows.source_type AS source_type,
    multiIf(
        JSONExtractString(metadata, 'measurement_kind') = 'direct', 'direct',
        JSONExtractString(metadata, 'measurement_kind') = 'estimated', 'estimated',
        'unknown'
    ) AS measurement_kind,
    assumeNotNull(metric_stream_rows.scalar) AS scalar,
    coalesce(
        device_priority_match.priority,
        active_sensor_provider_priority.priority,
        1000
    ) AS provider_priority,
    metric_stream_rows.ingested_at AS _peerdb_synced_at,
    metric_stream_rows.is_deleted AS _peerdb_is_deleted,
    metric_stream_rows.source_version AS _peerdb_version
FROM metric_stream_rows
LEFT JOIN active_sensor_provider_priority
    ON active_sensor_provider_priority.provider_id = metric_stream_rows.provider_id
    AND active_sensor_provider_priority.channel = metric_stream_rows.channel
LEFT JOIN device_priority_match
    ON device_priority_match.metric_stream_id = metric_stream_rows.id
