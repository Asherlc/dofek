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
    on_schema_change='append_new_columns',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, channel, recorded_date, recorded_at)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH selected_samples AS (
    SELECT
        samples.user_id AS user_id,
        samples.recorded_at AS recorded_at,
        samples.channel AS channel,
        argMinIf(
            tuple(
                samples.scalar,
                samples.provider_id,
                samples.member_activity_id,
                samples.device_id,
                samples.source_external_id,
                samples.source_type,
                samples.measurement_kind,
                samples.id,
                samples.activity_id
            ),
            (samples.provider_priority, samples.provider_id, samples.id),
            samples._peerdb_is_deleted = 0
        ) AS selected_sample,
        coalesce(
            minIf(samples.provider_priority, samples._peerdb_is_deleted = 0),
            65535
        ) AS provider_priority,
        max(samples._peerdb_synced_at) AS source_refreshed_at,
        countIf(samples._peerdb_is_deleted = 0) AS active_sample_count
    FROM {{ ref('sensor_scalar_sample') }} AS samples
    GROUP BY samples.user_id, samples.channel, samples.recorded_at
)

SELECT
    selected_samples.user_id AS user_id,
    selected_samples.recorded_at AS recorded_at,
    toDate(selected_samples.recorded_at) AS recorded_date,
    selected_samples.channel AS channel,
    tupleElement(selected_samples.selected_sample, 1) AS scalar,
    tupleElement(selected_samples.selected_sample, 2) AS provider_id,
    tupleElement(selected_samples.selected_sample, 3) AS member_activity_id,
    tupleElement(selected_samples.selected_sample, 4) AS device_id,
    tupleElement(selected_samples.selected_sample, 5) AS source_external_id,
    tupleElement(selected_samples.selected_sample, 6) AS source_type,
    tupleElement(selected_samples.selected_sample, 7) AS measurement_kind,
    tupleElement(selected_samples.selected_sample, 8) AS source_metric_stream_id,
    tupleElement(selected_samples.selected_sample, 9) AS source_activity_id,
    selected_samples.provider_priority AS provider_priority,
    selected_samples.source_refreshed_at AS source_refreshed_at,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    if(selected_samples.active_sample_count = 0, 1, 0) AS is_deleted,
    source_refreshed_at AS refreshed_at
FROM selected_samples
