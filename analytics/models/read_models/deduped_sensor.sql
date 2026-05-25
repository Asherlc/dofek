{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, channel, recorded_date, recorded_at)'
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

dirty_keys AS (
    SELECT DISTINCT
        user_id,
        channel,
        recorded_at
    FROM {{ ref('sensor_scalar_sample') }} FINAL
    {% if is_incremental() %}
        WHERE (
            (
                (SELECT is_empty FROM target_state)
                AND recorded_at >= now64(6, 'UTC') - INTERVAL {{ initial_lookback_days }} DAY
            )
            OR (
                NOT (SELECT is_empty FROM target_state)
                AND _peerdb_synced_at > (SELECT last_refreshed_at FROM target_state)
            )
        )
    {% else %}
        WHERE recorded_at >= now64(6, 'UTC') - INTERVAL {{ initial_lookback_days }} DAY
    {% endif %}
),

samples AS (
    SELECT *
    FROM {{ ref('sensor_scalar_sample') }} FINAL
    WHERE (user_id, channel, recorded_at) IN (
        SELECT
            user_id,
            channel,
            recorded_at
        FROM dirty_keys
    )
)

SELECT
    dirty_keys.user_id AS user_id,
    dirty_keys.recorded_at AS recorded_at,
    toDate(dirty_keys.recorded_at) AS recorded_date,
    dirty_keys.channel AS channel,
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
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    if(countIf(samples._peerdb_is_deleted = 0) = 0, 1, 0) AS is_deleted,
    now64(9) AS refreshed_at
FROM dirty_keys
LEFT JOIN samples
    ON samples.user_id = dirty_keys.user_id
    AND samples.channel = dirty_keys.channel
    AND samples.recorded_at = dirty_keys.recorded_at
GROUP BY dirty_keys.user_id, dirty_keys.channel, dirty_keys.recorded_at
