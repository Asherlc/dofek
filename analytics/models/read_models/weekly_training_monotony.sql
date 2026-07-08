{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, week)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH daily_load AS (
    SELECT
        user_id,
        assumeNotNull(date) AS load_date,
        sum(training_load) AS training_load
    FROM {{ ref('daily_endurance_load') }} FINAL
    WHERE is_deleted = 0
        AND date IS NOT NULL
    GROUP BY
        user_id,
        load_date
),

weekly_stats AS (
    SELECT
        user_id,
        toMonday(load_date) AS week,
        avg(training_load) AS mean_load,
        stddevPop(training_load) AS stdev_load,
        sum(training_load) AS weekly_load
    FROM daily_load
    GROUP BY
        user_id,
        toMonday(load_date)
    HAVING stddevPop(training_load) > 0
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    weekly_stats.user_id AS user_id,
    weekly_stats.week AS week,
    round(weekly_stats.mean_load / weekly_stats.stdev_load, 2) AS monotony,
    round(weekly_stats.weekly_load * (weekly_stats.mean_load / weekly_stats.stdev_load), 1) AS strain,
    round(weekly_stats.weekly_load, 1) AS weekly_load,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM weekly_stats
CROSS JOIN refresh_clock
