{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, date)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH {% if is_incremental() %}
existing_dates AS (
    SELECT
        user_id,
        max(date) AS latest_materialized_date
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
    LEFT JOIN existing_dates
        ON existing_dates.user_id = body.user_id
    {% endif %}
    WHERE body.weight_kg IS NOT NULL
        AND body.weight_kg > 0
        {% if is_incremental() %}
        AND (
            existing_dates.user_id IS NULL
            OR toDate(body.recorded_at) >= existing_dates.latest_materialized_date - INTERVAL 7 DAY
        )
        {% endif %}
),

ranked_body AS (
    SELECT
        user_id,
        toDate(recorded_at) AS date,
        recorded_at,
        weight_kg,
        body_fat_pct,
        row_number() OVER (
            PARTITION BY user_id, toDate(recorded_at)
            ORDER BY recorded_at DESC
        ) AS row_number
    FROM body_source
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    CAST(ranked_body.user_id, 'UUID') AS user_id,
    CAST(ranked_body.date, 'Date') AS date,
    ranked_body.recorded_at AS recorded_at,
    ranked_body.weight_kg AS weight_kg,
    ranked_body.body_fat_pct AS body_fat_pct,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM ranked_body
CROSS JOIN refresh_clock
WHERE ranked_body.row_number = 1
