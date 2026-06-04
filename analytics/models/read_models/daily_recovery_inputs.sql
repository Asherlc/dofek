{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, date)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH daily_metrics AS (
    SELECT
        user_id,
        date,
        hrv,
        respiratory_rate_avg AS respiratory_rate
    FROM analytics.v_daily_metrics
),

resting_by_date AS (
    SELECT
        user_id,
        toDate(ended_at - INTERVAL 6 HOUR) AS date,
        argMax(resting_hr, tuple(duration_seconds, ended_at)) AS selected_resting_hr
    FROM {{ ref('resting_heart_rate_sleep_window') }} FINAL
    WHERE is_deleted = 0
        AND ended_at IS NOT NULL
        AND resting_hr IS NOT NULL
    GROUP BY user_id, date
),

sleep_by_date AS (
    SELECT
        user_id,
        toDate(started_at - INTERVAL 6 HOUR) AS date,
        argMax(efficiency_pct, duration_minutes) AS efficiency_pct
    FROM analytics.v_sleep
    WHERE is_nap = FALSE
    GROUP BY user_id, date
),

input_dates AS (
    SELECT
        user_id,
        date
    FROM daily_metrics
    UNION DISTINCT
    SELECT
        user_id,
        date
    FROM resting_by_date
    UNION DISTINCT
    SELECT
        user_id,
        date
    FROM sleep_by_date
),

daily_inputs AS (
    SELECT
        input_dates.user_id AS user_id,
        input_dates.date AS date,
        daily_metrics.hrv AS hrv,
        resting_by_date.selected_resting_hr AS resting_hr,
        daily_metrics.respiratory_rate AS respiratory_rate,
        sleep_by_date.efficiency_pct AS efficiency_pct
    FROM input_dates
    LEFT JOIN daily_metrics
        ON daily_metrics.user_id = input_dates.user_id
        AND daily_metrics.date = input_dates.date
    LEFT JOIN resting_by_date
        ON resting_by_date.user_id = input_dates.user_id
        AND resting_by_date.date = input_dates.date
    LEFT JOIN sleep_by_date
        ON sleep_by_date.user_id = input_dates.user_id
        AND sleep_by_date.date = input_dates.date
),

inputs_with_baselines AS (
    SELECT
        user_id,
        date,
        hrv,
        resting_hr,
        respiratory_rate,
        efficiency_pct,
        avg(hrv) OVER (
            PARTITION BY user_id ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS hrv_mean_30d,
        stddevPop(hrv) OVER (
            PARTITION BY user_id ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS hrv_sd_30d,
        avg(resting_hr) OVER (
            PARTITION BY user_id ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS rhr_mean_30d,
        stddevPop(resting_hr) OVER (
            PARTITION BY user_id ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS rhr_sd_30d,
        avg(respiratory_rate) OVER (
            PARTITION BY user_id ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS rr_mean_30d,
        stddevPop(respiratory_rate) OVER (
            PARTITION BY user_id ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS rr_sd_30d,
        avg(hrv) OVER (
            PARTITION BY user_id ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
        ) AS hrv_mean_60d,
        stddevPop(hrv) OVER (
            PARTITION BY user_id ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
        ) AS hrv_sd_60d,
        avg(resting_hr) OVER (
            PARTITION BY user_id ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
        ) AS rhr_mean_60d,
        stddevPop(resting_hr) OVER (
            PARTITION BY user_id ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
        ) AS rhr_sd_60d
    FROM daily_inputs
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    CAST(inputs_with_baselines.user_id, 'UUID') AS user_id,
    CAST(inputs_with_baselines.date, 'Date') AS date,
    inputs_with_baselines.hrv AS hrv,
    inputs_with_baselines.resting_hr AS resting_hr,
    inputs_with_baselines.respiratory_rate AS respiratory_rate,
    inputs_with_baselines.efficiency_pct AS efficiency_pct,
    inputs_with_baselines.hrv_mean_30d AS hrv_mean_30d,
    inputs_with_baselines.hrv_sd_30d AS hrv_sd_30d,
    inputs_with_baselines.rhr_mean_30d AS rhr_mean_30d,
    inputs_with_baselines.rhr_sd_30d AS rhr_sd_30d,
    inputs_with_baselines.rr_mean_30d AS rr_mean_30d,
    inputs_with_baselines.rr_sd_30d AS rr_sd_30d,
    inputs_with_baselines.hrv_mean_60d AS hrv_mean_60d,
    inputs_with_baselines.hrv_sd_60d AS hrv_sd_60d,
    inputs_with_baselines.rhr_mean_60d AS rhr_mean_60d,
    inputs_with_baselines.rhr_sd_60d AS rhr_sd_60d,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM inputs_with_baselines
CROSS JOIN refresh_clock
