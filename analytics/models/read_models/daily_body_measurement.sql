{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, recorded_at)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH {% if is_incremental() %}
existing_measurements AS (
    SELECT
        user_id,
        max(recorded_at) AS latest_recorded_at
    FROM {{ this }}
    GROUP BY user_id
),
{% endif %}

body_source AS (
    SELECT
        body.user_id AS user_id,
        body.recorded_at AS recorded_at,
        body.weight_kg AS weight_kg,
        body.body_fat_pct AS body_fat_pct
    FROM analytics.v_body_measurement AS body
    {% if is_incremental() %}
    LEFT JOIN existing_measurements
        ON existing_measurements.user_id = body.user_id
    {% endif %}
    WHERE body.weight_kg IS NOT NULL
        AND body.weight_kg > 0
        {% if is_incremental() %}
        AND (
            existing_measurements.user_id IS NULL
            -- Re-materialize a 7-day overlap for late updates; ReplacingMergeTree
            -- deduplicates rows by (user_id, recorded_at) on refresh_version.
            OR body.recorded_at >= existing_measurements.latest_recorded_at - INTERVAL 7 DAY
        )
        {% endif %}
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    CAST(body_source.user_id, 'UUID') AS user_id,
    CAST(toDate(body_source.recorded_at), 'Date') AS date,
    body_source.recorded_at AS recorded_at,
    body_source.weight_kg AS weight_kg,
    body_source.body_fat_pct AS body_fat_pct,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM body_source
CROSS JOIN refresh_clock
