{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, date)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH ranked_sleep AS (
    SELECT
        user_id,
        toDate(started_at - INTERVAL 6 HOUR) AS date,
        provider_id,
        started_at,
        ended_at,
        duration_minutes,
        deep_minutes,
        rem_minutes,
        light_minutes,
        awake_minutes,
        efficiency_pct,
        row_number() OVER (
            PARTITION BY user_id, toDate(started_at - INTERVAL 6 HOUR)
            ORDER BY duration_minutes DESC NULLS LAST, started_at DESC
        ) AS row_number
    FROM analytics.v_sleep
    WHERE is_nap = FALSE
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    CAST(ranked_sleep.user_id, 'UUID') AS user_id,
    CAST(ranked_sleep.date, 'Date') AS date,
    ranked_sleep.provider_id AS provider_id,
    ranked_sleep.started_at AS started_at,
    ranked_sleep.ended_at AS ended_at,
    ranked_sleep.duration_minutes AS duration_minutes,
    ranked_sleep.deep_minutes AS deep_minutes,
    ranked_sleep.rem_minutes AS rem_minutes,
    ranked_sleep.light_minutes AS light_minutes,
    ranked_sleep.awake_minutes AS awake_minutes,
    ranked_sleep.efficiency_pct AS efficiency_pct,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM ranked_sleep
CROSS JOIN refresh_clock
WHERE ranked_sleep.row_number = 1
