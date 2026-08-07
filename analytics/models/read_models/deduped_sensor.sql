{% set default_microbatch_begin = run_started_at.strftime('%Y-%m-%d') %}
{% set deduped_sensor_begin = var('deduped_sensor_begin', default_microbatch_begin) %}

{{ config(
    materialized='incremental',
    incremental_strategy='microbatch',
    unique_key=['user_id', 'channel', 'recorded_at'],
    event_time='refreshed_at',
    begin=deduped_sensor_begin,
    batch_size='day',
    lookback=3,
    full_refresh=false,
    concurrent_batches=false,
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, channel, recorded_date, recorded_at)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH samples AS (
    SELECT *
    FROM {{ ref('sensor_scalar_sample') }}
),

batch_keys AS (
    SELECT DISTINCT
        user_id,
        channel,
        recorded_at
    FROM samples
)

SELECT
    batch_keys.user_id AS user_id,
    batch_keys.recorded_at AS recorded_at,
    toDate(batch_keys.recorded_at) AS recorded_date,
    batch_keys.channel AS channel,
    argMinIf(
        samples.scalar,
        (samples.provider_priority, samples.provider_id, samples.id),
        samples._peerdb_is_deleted = 0
    ) AS scalar,
    argMinIf(
        samples.provider_id,
        (samples.provider_priority, samples.provider_id, samples.id),
        samples._peerdb_is_deleted = 0
    ) AS provider_id,
    argMinIf(
        samples.id,
        (samples.provider_priority, samples.provider_id, samples.id),
        samples._peerdb_is_deleted = 0
    ) AS source_metric_stream_id,
    coalesce(
        minIf(samples.provider_priority, samples._peerdb_is_deleted = 0),
        65535
    ) AS provider_priority,
    max(samples._peerdb_synced_at) AS source_refreshed_at,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    if(countIf(samples._peerdb_is_deleted = 0) = 0, 1, 0) AS is_deleted,
    source_refreshed_at AS refreshed_at
FROM batch_keys
LEFT JOIN samples
    ON samples.user_id = batch_keys.user_id
    AND samples.channel = batch_keys.channel
    AND samples.recorded_at = batch_keys.recorded_at
GROUP BY batch_keys.user_id, batch_keys.channel, batch_keys.recorded_at
