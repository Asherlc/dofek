{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, date)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH activity_load AS (
    SELECT
        user_id,
        toDate(started_at) AS date,
        coalesce(sum(daily_load), 0) AS daily_load
    FROM {{ ref('daily_activity_load') }} FINAL
    WHERE started_at IS NOT NULL
    GROUP BY user_id, toDate(started_at)
),

date_bounds AS (
    SELECT
        user_id,
        min(date) AS min_date,
        greatest(max(date), today()) AS max_date
    FROM activity_load
    GROUP BY user_id
),

date_series AS (
    SELECT
        user_id,
        min_date + INTERVAL date_offset DAY AS date
    FROM date_bounds
    ARRAY JOIN range(
        toUInt32(dateDiff('day', min_date, max_date) + 1)
    ) AS date_offset
),

daily AS (
    SELECT
        date_series.user_id AS user_id,
        date_series.date AS date,
        coalesce(activity_load.daily_load, 0) AS daily_load
    FROM date_series
    LEFT JOIN activity_load
        ON activity_load.user_id = date_series.user_id
        AND activity_load.date = date_series.date
),

with_windows AS (
    SELECT
        user_id,
        date,
        daily_load,
        sum(daily_load) OVER (
            PARTITION BY user_id ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        ) AS acute_load_7d,
        avg(daily_load) OVER (
            PARTITION BY user_id ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW
        ) * 7 AS chronic_load_28d,
        count() OVER (
            PARTITION BY user_id ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW
        ) AS chronic_count
    FROM daily
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    CAST(user_id, 'UUID') AS user_id,
    CAST(date, 'Date') AS date,
    daily_load,
    least(21, round(2.775 * log(1 + greatest(daily_load, 0)), 1)) AS strain,
    acute_load_7d,
    chronic_load_28d,
    if(chronic_load_28d > 0 AND chronic_count = 28, acute_load_7d / chronic_load_28d, NULL) AS workload_ratio,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM with_windows
CROSS JOIN refresh_clock
