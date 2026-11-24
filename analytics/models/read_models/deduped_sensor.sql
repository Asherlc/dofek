{% set default_microbatch_begin = run_started_at.strftime('%Y-%m-%d') %}
{% set deduped_sensor_begin = var('deduped_sensor_begin', default_microbatch_begin) %}

{{ config(
    materialized='incremental',
    incremental_strategy='microbatch',
    unique_key=['user_id', 'channel', 'recorded_at'],
    event_time='refreshed_at',
    begin=deduped_sensor_begin,
    batch_size='day',
    lookback=1,
    full_refresh=false,
    concurrent_batches=false,
    on_schema_change='append_new_columns',
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
    query_settings={
        'max_threads': 1
    }
) }}

WITH changed_keys AS (
    SELECT DISTINCT
        user_id,
        channel,
        recorded_date,
        recorded_at
    FROM {{ ref('sensor_scalar_sample') }}
),

current_samples AS (
    SELECT *
    FROM {{ ref('sensor_scalar_sample').render() }}
    WHERE (user_id, channel, recorded_date, recorded_at) IN (
        SELECT
            user_id,
            channel,
            recorded_date,
            recorded_at
        FROM changed_keys
    )
    ORDER BY _peerdb_version DESC
    LIMIT 1 BY id
),

selected_samples AS (
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
            (
                samples.provider_priority,
                samples.provider_id,
                samples.channel = 'heart_rate' AND samples.measurement_kind = 'estimated',
                samples.id
            ),
            samples._peerdb_is_deleted = 0
        ) AS selected_sample,
        coalesce(
            minIf(samples.provider_priority, samples._peerdb_is_deleted = 0),
            65535
        ) AS provider_priority,
        max(samples._peerdb_synced_at) AS source_refreshed_at,
        countIf(samples._peerdb_is_deleted = 0) AS active_sample_count
    FROM current_samples AS samples
    GROUP BY samples.user_id, samples.channel, samples.recorded_at
),

staged AS (
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
)
{% if is_incremental() %}
,
existing_heart_rate AS (
    SELECT
        user_id,
        channel,
        recorded_date,
        recorded_at,
        scalar,
        is_deleted,
        heart_rate_changed_at,
        toUInt8(1) AS row_present
    FROM {{ this }} FINAL
    WHERE channel = 'heart_rate'
        AND (user_id, channel, recorded_date, recorded_at) IN (
            SELECT
                user_id,
                channel,
                recorded_date,
                recorded_at
            FROM changed_keys
            WHERE channel = 'heart_rate'
        )
)
{% endif %}

SELECT
    staged.*,
    multiIf(
        staged.channel != 'heart_rate',
        toDateTime64('1970-01-01 00:00:00', 9, 'UTC'),
        {% if is_incremental() %}
        coalesce(existing_heart_rate.row_present, 0) = 1
            AND existing_heart_rate.is_deleted = staged.is_deleted
            AND (
                (staged.scalar IS NULL AND existing_heart_rate.scalar IS NULL)
                OR (
                    staged.scalar IS NOT NULL
                    AND existing_heart_rate.scalar IS NOT NULL
                    AND toFloat32(staged.scalar) = existing_heart_rate.scalar
                )
            ),
        assumeNotNull(existing_heart_rate.heart_rate_changed_at),
        {% endif %}
        now64(9, 'UTC')
    ) AS heart_rate_changed_at
FROM staged
{% if is_incremental() %}
LEFT JOIN existing_heart_rate
    ON existing_heart_rate.user_id = staged.user_id
    AND existing_heart_rate.channel = staged.channel
    AND existing_heart_rate.recorded_date = staged.recorded_date
    AND existing_heart_rate.recorded_at = staged.recorded_at
{% endif %}
