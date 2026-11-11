{% set health_sensor_day_batch_size = var('health_sensor_day_batch_size', 32) %}

{{ config(
    materialized='incremental',
    incremental_strategy='append',
    full_refresh=false,
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, provider_id, recorded_date)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1,
        'transform_null_in': 1,
        'enable_materialized_cte': 1
    }
) }}

WITH source_days AS (
    SELECT
        user_id,
        provider_id,
        recorded_date,
        max(changed_at) AS source_changed_at
    FROM {{ source('analytics', 'metric_stream_day_change') }}
    GROUP BY user_id, provider_id, recorded_date
),

dirty_days AS MATERIALIZED (
    SELECT source_days.*
    FROM source_days
    {% if is_incremental() %}
    LEFT JOIN {{ this }} AS existing FINAL
        ON existing.user_id = source_days.user_id
        AND existing.provider_id = source_days.provider_id
        AND existing.recorded_date = source_days.recorded_date
    WHERE existing.recorded_date IS NULL
        OR source_days.source_changed_at > existing.source_changed_at
    {% endif %}
    ORDER BY
        source_days.source_changed_at,
        source_days.user_id,
        source_days.provider_id,
        source_days.recorded_date
    LIMIT {{ health_sensor_day_batch_size }}
),

sample_keys AS (
    SELECT
        user_id,
        activity_id,
        channel,
        recorded_at,
        id
    FROM {{ source('ingest', 'metric_stream_current') }}
    WHERE (user_id, channel, toDate(recorded_at)) IN (
        SELECT
            user_id,
            selected_channel,
            recorded_date
        FROM dirty_days
        ARRAY JOIN ['spo2', 'sensor_record'] AS selected_channel
    )
        AND (user_id, provider_id, toDate(recorded_at)) IN (
            SELECT
                user_id,
                provider_id,
                recorded_date
            FROM dirty_days
        )
),

current_samples AS (
    SELECT
        id,
        user_id,
        provider_id,
        recorded_at,
        channel,
        device_id,
        scalar,
        JSONExtractString(metadata, 'frameHex') AS frame_hex
    FROM {{ source('ingest', 'metric_stream_current') }} FINAL
    WHERE (user_id, activity_id, channel, recorded_at, id) IN (
        SELECT
            user_id,
            activity_id,
            channel,
            recorded_at,
            id
        FROM sample_keys
    )
        AND (channel = 'spo2' OR (provider_id = 'whoop_ble' AND channel = 'sensor_record'))
        AND is_deleted = 0
),

decoded AS (
    SELECT
        id,
        user_id,
        provider_id,
        toDate(recorded_at) AS recorded_date,
        device_id AS source_name,
        if(channel = 'spo2', 'spo2', 'skin_temperature') AS channel,
        if(
            channel = 'spo2',
            recorded_at,
            fromUnixTimestamp64Micro(
                toInt64(reinterpretAsUInt32(unhex(substring(frame_hex, 31, 8)))) * 1000000
                + toInt64(round(reinterpretAsUInt16(unhex(substring(frame_hex, 39, 4))) * 1000 / 32768)) * 1000
            )
        ) AS measured_at,
        if(
            channel = 'spo2',
            if(provider_id = 'apple_health', scalar * 100, scalar),
            reinterpretAsUInt16(unhex(substring(frame_hex, 147, 4))) / 100.0
        ) AS value
    FROM current_samples
    WHERE channel = 'spo2'
        OR (length(frame_hex) = 248 AND substring(frame_hex, 17, 6) = '2f1280')
),

daily_samples AS (
    SELECT
        user_id,
        provider_id,
        recorded_date,
        groupArray(CAST(
            (id, measured_at, channel, source_name, assumeNotNull(toFloat64(value))),
            'Tuple(id UUID, measured_at DateTime64(6, \'UTC\'), channel String, source_name Nullable(String), value Float64)'
        )) AS samples
    FROM decoded
    WHERE isFinite(value)
        AND ((channel = 'spo2' AND value > 0 AND value <= 100)
            OR (channel = 'skin_temperature' AND value BETWEEN 5 AND 45))
    GROUP BY user_id, provider_id, recorded_date
)

SELECT
    dirty_days.user_id AS user_id,
    dirty_days.provider_id AS provider_id,
    dirty_days.recorded_date AS recorded_date,
    coalesce(daily_samples.samples, CAST([], 'Array(Tuple(id UUID, measured_at DateTime64(6, \'UTC\'), channel String, source_name Nullable(String), value Float64))')) AS samples,
    dirty_days.source_changed_at AS source_changed_at,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9, 'UTC') AS refreshed_at
FROM dirty_days
LEFT JOIN daily_samples
    ON daily_samples.user_id = dirty_days.user_id
    AND daily_samples.provider_id = dirty_days.provider_id
    AND daily_samples.recorded_date = dirty_days.recorded_date
