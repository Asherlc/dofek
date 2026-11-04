{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key='id',
    full_refresh=false,
    on_schema_change='fail',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, channel, recorded_date, recorded_at, provider_id, id)',
    query_settings={'max_threads': 1}
) }}

WITH {{ analytics_effect_scope('scalar') }}
{{ analytics_sensor_candidates() }}
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
            analytics_sensor_rows.id AS metric_stream_id,
            active_sensor_device_priority.priority AS priority,
            row_number() OVER (
                PARTITION BY analytics_sensor_rows.id
                ORDER BY
                    length(active_sensor_device_priority.source_name_pattern) DESC,
                    active_sensor_device_priority.priority ASC,
                    active_sensor_device_priority.source_name_pattern ASC
            ) AS row_number
        FROM analytics_sensor_rows
        INNER JOIN active_sensor_device_priority
            ON active_sensor_device_priority.provider_id = analytics_sensor_rows.provider_id
            AND active_sensor_device_priority.channel = analytics_sensor_rows.channel
            AND analytics_sensor_rows.device_id IS NOT null
            AND assumeNotNull(analytics_sensor_rows.device_id)
            LIKE active_sensor_device_priority.source_name_pattern
    )
    WHERE row_number = 1
)

SELECT
    analytics_sensor_rows.id AS id,
    analytics_sensor_rows.activity_id AS activity_id,
    analytics_sensor_rows.activity_id AS member_activity_id,
    analytics_sensor_rows.user_id AS user_id,
    analytics_sensor_rows.recorded_at AS recorded_at,
    toDate(analytics_sensor_rows.recorded_at) AS recorded_date,
    analytics_sensor_rows.channel AS channel,
    analytics_sensor_rows.provider_id AS provider_id,
    analytics_sensor_rows.source_external_id AS source_external_id,
    analytics_sensor_rows.device_id AS device_id,
    analytics_sensor_rows.source_type AS source_type,
    multiIf(
        analytics_sensor_rows.derived_heart_rate, 'estimated',
        JSONExtractString(metadata, 'measurement_kind') = 'direct', 'direct',
        JSONExtractString(metadata, 'measurement_kind') = 'estimated', 'estimated',
        'unknown'
    ) AS measurement_kind,
    assumeNotNull(analytics_sensor_rows.scalar) AS scalar,
    coalesce(
        device_priority_match.priority,
        active_sensor_provider_priority.priority,
        1000
    ) AS provider_priority,
    analytics_sensor_rows.ingested_at AS _peerdb_synced_at,
    analytics_sensor_rows.is_deleted AS _peerdb_is_deleted,
    analytics_sensor_rows.source_version AS _peerdb_version,
    toUInt64('{{ var("analytics_publication_revision") }}') AS refresh_version
FROM analytics_sensor_rows
LEFT JOIN active_sensor_provider_priority
    ON active_sensor_provider_priority.provider_id = analytics_sensor_rows.provider_id
    AND active_sensor_provider_priority.channel = analytics_sensor_rows.channel
LEFT JOIN device_priority_match
    ON device_priority_match.metric_stream_id = analytics_sensor_rows.id
