{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH activity_load AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        ended_at,
        dateDiff('second', started_at, ended_at) / 60.0
        * avg_hr / nullIf(toFloat64(max_hr), 0) AS daily_load
    FROM {{ ref('activity_summary_rows') }}
    WHERE ended_at IS NOT NULL
        AND avg_hr IS NOT NULL
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    activity_load.activity_id AS activity_id,
    activity_load.user_id AS user_id,
    activity_load.started_at AS started_at,
    activity_load.ended_at AS ended_at,
    activity_load.daily_load AS daily_load,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM activity_load
CROSS JOIN refresh_clock
