{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key=['user_id', 'channel', 'recorded_at'],
    full_refresh=false,
    on_schema_change='fail',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, channel, recorded_date, recorded_at)',
    settings={
        'deduplicate_merge_projection_mode': 'rebuild',
        'lightweight_mutation_projection_mode': 'rebuild'
    },
    projections=[{
        'name': 'by_user_channel_day_refresh',
        'query': 'SELECT user_id, channel, recorded_date, max(refresh_version) AS source_refresh_version GROUP BY user_id, channel, recorded_date'
    }],
    query_settings={'max_threads': 1}
) }}

WITH {{ analytics_effect_scope('dedup') }}
{{ analytics_sensor_candidates() }}
current_samples AS (
    SELECT * FROM {{ ref('sensor_scalar_sample') }}
    WHERE (user_id, channel, recorded_date, recorded_at, provider_id, id) IN (
        SELECT user_id, channel, toDate(recorded_at), recorded_at, provider_id, id
        FROM analytics_sensor_rows
    )
    ORDER BY user_id ASC, channel ASC, recorded_date ASC, recorded_at ASC, provider_id ASC, id ASC, refresh_version DESC
    LIMIT 1 BY user_id, channel, recorded_date, recorded_at, provider_id, id
),
scalar_publication_check AS (
    SELECT throwIf(countIf(
        samples.id = toUUID('00000000-0000-0000-0000-000000000000')
        OR samples._peerdb_version != expected.source_version
        OR samples._peerdb_synced_at != expected.ingested_at
        OR samples._peerdb_is_deleted != expected.is_deleted
    ) != 0, 'Missing or stale current scalar publication') AS scalar_check
    FROM analytics_sensor_rows AS expected
    LEFT JOIN current_samples AS samples
        ON expected.user_id = samples.user_id AND expected.channel = samples.channel
        AND expected.recorded_at = samples.recorded_at AND expected.provider_id = samples.provider_id
        AND expected.id = samples.id
),
selected_samples AS (
    SELECT
        samples.user_id AS user_id, samples.recorded_at AS recorded_at, samples.channel AS channel,
        argMinIf(tuple(samples.scalar, samples.provider_id, samples.member_activity_id, samples.device_id,
            samples.source_external_id, samples.source_type, samples.measurement_kind, samples.id, samples.activity_id),
            (samples.provider_priority, samples.provider_id,
                samples.channel = 'heart_rate' AND samples.measurement_kind = 'estimated', samples.id),
            samples._peerdb_is_deleted = 0) AS selected_sample,
        minIf(samples.provider_priority, samples._peerdb_is_deleted = 0) AS provider_priority,
        max(samples._peerdb_synced_at) AS source_refreshed_at,
        countIf(samples._peerdb_is_deleted = 0) AS active_sample_count
    FROM current_samples AS samples
    WHERE (SELECT scalar_check FROM scalar_publication_check) = 0
        AND (SELECT owner_check + placement_check + payload_check + structure_check FROM analytics_candidate_check) = 0
    GROUP BY samples.user_id, samples.channel, samples.recorded_at
)
SELECT
    user_id, recorded_at, toDate(recorded_at) AS recorded_date, channel,
    if(active_sample_count = 0, NULL, selected_sample.1) AS scalar,
    if(active_sample_count = 0, NULL, selected_sample.2) AS provider_id,
    if(active_sample_count = 0, NULL, selected_sample.3) AS member_activity_id,
    if(active_sample_count = 0, NULL, selected_sample.4) AS device_id,
    if(active_sample_count = 0, NULL, selected_sample.5) AS source_external_id,
    if(active_sample_count = 0, NULL, selected_sample.6) AS source_type,
    if(active_sample_count = 0, 'unknown', selected_sample.7) AS measurement_kind,
    if(active_sample_count = 0, NULL, selected_sample.8) AS source_metric_stream_id,
    if(active_sample_count = 0, NULL, selected_sample.9) AS source_activity_id,
    if(active_sample_count = 0, 65535, provider_priority) AS provider_priority,
    source_refreshed_at,
    toUInt64('{{ var("analytics_publication_revision") }}') AS refresh_version,
    toUInt8(active_sample_count = 0) AS is_deleted,
    source_refreshed_at AS refreshed_at
FROM selected_samples
