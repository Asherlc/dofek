{% set heart_rate_day_freshness_lookback_hours = var('heart_rate_day_freshness_lookback_hours', 6) %}

{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, recorded_date)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

WITH
{% if is_incremental() %}
watermark AS (
    SELECT max(refreshed_at) AS max_refreshed_at
    FROM {{ this }} FINAL
),

scan_cutoff AS (
    SELECT
        coalesce(
            max_refreshed_at,
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
        ) - INTERVAL {{ heart_rate_day_freshness_lookback_hours }} HOUR AS cutoff_at
    FROM watermark
),
{% endif %}

changed_heart_rate_days AS (
    SELECT
        samples.user_id AS user_id,
        samples.recorded_date AS recorded_date,
        max(samples.refreshed_at) AS refreshed_at,
        countIf(samples.is_deleted = 0) > 0 AS has_live_samples
    FROM {{ ref('deduped_sensor') }} AS samples FINAL
    WHERE samples.channel = 'heart_rate'
    {% if is_incremental() %}
        AND samples.refreshed_at > (SELECT cutoff_at FROM scan_cutoff)
    {% endif %}
    GROUP BY
        samples.user_id,
        samples.recorded_date
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    assumeNotNull(changed_heart_rate_days.user_id) AS user_id,
    assumeNotNull(changed_heart_rate_days.recorded_date) AS recorded_date,
    changed_heart_rate_days.refreshed_at AS refreshed_at,
    changed_heart_rate_days.has_live_samples AS has_live_samples,
    refresh_clock.refresh_version AS refresh_version
FROM changed_heart_rate_days
CROSS JOIN refresh_clock
WHERE changed_heart_rate_days.user_id IS NOT NULL
    AND changed_heart_rate_days.recorded_date IS NOT NULL
