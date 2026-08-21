{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, date)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

WITH {% if is_incremental() %}
existing_rows AS (
    SELECT
        user_id,
        date,
        hrv,
        resting_hr,
        respiratory_rate,
        efficiency_pct,
        hrv_mean_30d,
        hrv_sd_30d,
        hrv_baseline_sample_count,
        hrv_baseline_coverage,
        hrv_mean_7d,
        hrv_mean_previous_28d,
        rhr_mean_30d,
        rhr_sd_30d,
        rhr_baseline_sample_count,
        rhr_baseline_coverage,
        rhr_mean_7d,
        rhr_mean_previous_28d,
        rr_mean_30d,
        rr_sd_30d,
        rr_baseline_sample_count,
        rr_baseline_coverage,
        rr_mean_7d,
        rr_mean_previous_28d,
        efficiency_mean_30d,
        efficiency_sd_30d,
        efficiency_baseline_sample_count,
        efficiency_baseline_coverage,
        efficiency_mean_7d,
        efficiency_mean_previous_28d,
        hrv_mean_60d,
        hrv_sd_60d,
        rhr_mean_60d,
        rhr_sd_60d
    FROM {{ this }} FINAL
    WHERE is_deleted = 0
),
{% endif %}

daily_metrics AS (
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
        date,
        efficiency_pct
    FROM {{ ref('daily_sleep') }} FINAL
    WHERE is_deleted = 0
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

window_statistics AS (
    SELECT
        user_id,
        date,
        hrv,
        resting_hr,
        respiratory_rate,
        efficiency_pct,
        avgOrNull(hrv) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS hrv_mean_30d,
        stddevPop(hrv) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS hrv_sd_30d_raw,
        countIf(hrv IS NOT NULL) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS hrv_baseline_sample_count,
        avgOrNull(hrv) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 6 PRECEDING AND CURRENT ROW
        ) AS hrv_mean_7d,
        avgOrNull(hrv) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 34 PRECEDING AND 7 PRECEDING
        ) AS hrv_mean_previous_28d,
        avgOrNull(resting_hr) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS rhr_mean_30d,
        stddevPop(resting_hr) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS rhr_sd_30d_raw,
        countIf(resting_hr IS NOT NULL) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS rhr_baseline_sample_count,
        avgOrNull(resting_hr) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 6 PRECEDING AND CURRENT ROW
        ) AS rhr_mean_7d,
        avgOrNull(resting_hr) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 34 PRECEDING AND 7 PRECEDING
        ) AS rhr_mean_previous_28d,
        avgOrNull(respiratory_rate) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS rr_mean_30d,
        stddevPop(respiratory_rate) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS rr_sd_30d_raw,
        countIf(respiratory_rate IS NOT NULL) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS rr_baseline_sample_count,
        avgOrNull(respiratory_rate) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 6 PRECEDING AND CURRENT ROW
        ) AS rr_mean_7d,
        avgOrNull(respiratory_rate) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 34 PRECEDING AND 7 PRECEDING
        ) AS rr_mean_previous_28d,
        avgOrNull(efficiency_pct) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS efficiency_mean_30d,
        stddevPop(efficiency_pct) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS efficiency_sd_30d_raw,
        countIf(efficiency_pct IS NOT NULL) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS efficiency_baseline_sample_count,
        avgOrNull(efficiency_pct) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 6 PRECEDING AND CURRENT ROW
        ) AS efficiency_mean_7d,
        avgOrNull(efficiency_pct) OVER (
            PARTITION BY user_id ORDER BY toUInt32(date)
            RANGE BETWEEN 34 PRECEDING AND 7 PRECEDING
        ) AS efficiency_mean_previous_28d,
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

inputs_with_baselines AS (
    SELECT
        * EXCEPT (
            hrv_sd_30d_raw,
            rhr_sd_30d_raw,
            rr_sd_30d_raw,
            efficiency_sd_30d_raw
        ),
        if(
            hrv_baseline_sample_count >= 2,
            hrv_sd_30d_raw,
            CAST(NULL, 'Nullable(Float64)')
        ) AS hrv_sd_30d,
        hrv_baseline_sample_count / 30.0 AS hrv_baseline_coverage,
        if(
            rhr_baseline_sample_count >= 2,
            rhr_sd_30d_raw,
            CAST(NULL, 'Nullable(Float64)')
        ) AS rhr_sd_30d,
        rhr_baseline_sample_count / 30.0 AS rhr_baseline_coverage,
        if(
            rr_baseline_sample_count >= 2,
            rr_sd_30d_raw,
            CAST(NULL, 'Nullable(Float64)')
        ) AS rr_sd_30d,
        rr_baseline_sample_count / 30.0 AS rr_baseline_coverage,
        if(
            efficiency_baseline_sample_count >= 2,
            efficiency_sd_30d_raw,
            CAST(NULL, 'Nullable(Float64)')
        ) AS efficiency_sd_30d,
        efficiency_baseline_sample_count / 30.0 AS efficiency_baseline_coverage
    FROM window_statistics
),

{% if is_incremental() %}
dirty_keys AS (
    SELECT
        inputs_with_baselines.user_id AS user_id,
        inputs_with_baselines.date AS date
    FROM inputs_with_baselines
    LEFT JOIN existing_rows
        ON existing_rows.user_id = inputs_with_baselines.user_id
        AND existing_rows.date = inputs_with_baselines.date
    WHERE existing_rows.user_id IS NULL
        OR tuple(
            inputs_with_baselines.hrv,
            inputs_with_baselines.resting_hr,
            inputs_with_baselines.respiratory_rate,
            inputs_with_baselines.efficiency_pct,
            inputs_with_baselines.hrv_mean_30d,
            inputs_with_baselines.hrv_sd_30d,
            inputs_with_baselines.hrv_baseline_sample_count,
            inputs_with_baselines.hrv_baseline_coverage,
            inputs_with_baselines.hrv_mean_7d,
            inputs_with_baselines.hrv_mean_previous_28d,
            inputs_with_baselines.rhr_mean_30d,
            inputs_with_baselines.rhr_sd_30d,
            inputs_with_baselines.rhr_baseline_sample_count,
            inputs_with_baselines.rhr_baseline_coverage,
            inputs_with_baselines.rhr_mean_7d,
            inputs_with_baselines.rhr_mean_previous_28d,
            inputs_with_baselines.rr_mean_30d,
            inputs_with_baselines.rr_sd_30d,
            inputs_with_baselines.rr_baseline_sample_count,
            inputs_with_baselines.rr_baseline_coverage,
            inputs_with_baselines.rr_mean_7d,
            inputs_with_baselines.rr_mean_previous_28d,
            inputs_with_baselines.efficiency_mean_30d,
            inputs_with_baselines.efficiency_sd_30d,
            inputs_with_baselines.efficiency_baseline_sample_count,
            inputs_with_baselines.efficiency_baseline_coverage,
            inputs_with_baselines.efficiency_mean_7d,
            inputs_with_baselines.efficiency_mean_previous_28d,
            inputs_with_baselines.hrv_mean_60d,
            inputs_with_baselines.hrv_sd_60d,
            inputs_with_baselines.rhr_mean_60d,
            inputs_with_baselines.rhr_sd_60d
        ) IS DISTINCT FROM tuple(
            existing_rows.hrv,
            existing_rows.resting_hr,
            existing_rows.respiratory_rate,
            existing_rows.efficiency_pct,
            existing_rows.hrv_mean_30d,
            existing_rows.hrv_sd_30d,
            existing_rows.hrv_baseline_sample_count,
            existing_rows.hrv_baseline_coverage,
            existing_rows.hrv_mean_7d,
            existing_rows.hrv_mean_previous_28d,
            existing_rows.rhr_mean_30d,
            existing_rows.rhr_sd_30d,
            existing_rows.rhr_baseline_sample_count,
            existing_rows.rhr_baseline_coverage,
            existing_rows.rhr_mean_7d,
            existing_rows.rhr_mean_previous_28d,
            existing_rows.rr_mean_30d,
            existing_rows.rr_sd_30d,
            existing_rows.rr_baseline_sample_count,
            existing_rows.rr_baseline_coverage,
            existing_rows.rr_mean_7d,
            existing_rows.rr_mean_previous_28d,
            existing_rows.efficiency_mean_30d,
            existing_rows.efficiency_sd_30d,
            existing_rows.efficiency_baseline_sample_count,
            existing_rows.efficiency_baseline_coverage,
            existing_rows.efficiency_mean_7d,
            existing_rows.efficiency_mean_previous_28d,
            existing_rows.hrv_mean_60d,
            existing_rows.hrv_sd_60d,
            existing_rows.rhr_mean_60d,
            existing_rows.rhr_sd_60d
        )
    UNION DISTINCT
    SELECT
        existing_rows.user_id AS user_id,
        existing_rows.date AS date
    FROM existing_rows
    LEFT JOIN inputs_with_baselines
        ON inputs_with_baselines.user_id = existing_rows.user_id
        AND inputs_with_baselines.date = existing_rows.date
    WHERE inputs_with_baselines.user_id IS NULL
),
{% endif %}

result_keys AS (
    {% if is_incremental() %}
    SELECT
        user_id,
        date
    FROM dirty_keys
    {% else %}
    SELECT
        user_id,
        date
    FROM inputs_with_baselines
    {% endif %}
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9, 'UTC') AS refreshed_at
)

SELECT
    CAST(result_keys.user_id, 'UUID') AS user_id,
    CAST(result_keys.date, 'Date') AS date,
    inputs_with_baselines.hrv AS hrv,
    inputs_with_baselines.resting_hr AS resting_hr,
    inputs_with_baselines.respiratory_rate AS respiratory_rate,
    inputs_with_baselines.efficiency_pct AS efficiency_pct,
    inputs_with_baselines.hrv_mean_30d AS hrv_mean_30d,
    inputs_with_baselines.hrv_sd_30d AS hrv_sd_30d,
    inputs_with_baselines.hrv_baseline_sample_count AS hrv_baseline_sample_count,
    inputs_with_baselines.hrv_baseline_coverage AS hrv_baseline_coverage,
    inputs_with_baselines.hrv_mean_7d AS hrv_mean_7d,
    inputs_with_baselines.hrv_mean_previous_28d AS hrv_mean_previous_28d,
    inputs_with_baselines.rhr_mean_30d AS rhr_mean_30d,
    inputs_with_baselines.rhr_sd_30d AS rhr_sd_30d,
    inputs_with_baselines.rhr_baseline_sample_count AS rhr_baseline_sample_count,
    inputs_with_baselines.rhr_baseline_coverage AS rhr_baseline_coverage,
    inputs_with_baselines.rhr_mean_7d AS rhr_mean_7d,
    inputs_with_baselines.rhr_mean_previous_28d AS rhr_mean_previous_28d,
    inputs_with_baselines.rr_mean_30d AS rr_mean_30d,
    inputs_with_baselines.rr_sd_30d AS rr_sd_30d,
    inputs_with_baselines.rr_baseline_sample_count AS rr_baseline_sample_count,
    inputs_with_baselines.rr_baseline_coverage AS rr_baseline_coverage,
    inputs_with_baselines.rr_mean_7d AS rr_mean_7d,
    inputs_with_baselines.rr_mean_previous_28d AS rr_mean_previous_28d,
    inputs_with_baselines.efficiency_mean_30d AS efficiency_mean_30d,
    inputs_with_baselines.efficiency_sd_30d AS efficiency_sd_30d,
    inputs_with_baselines.efficiency_baseline_sample_count AS efficiency_baseline_sample_count,
    inputs_with_baselines.efficiency_baseline_coverage AS efficiency_baseline_coverage,
    inputs_with_baselines.efficiency_mean_7d AS efficiency_mean_7d,
    inputs_with_baselines.efficiency_mean_previous_28d AS efficiency_mean_previous_28d,
    inputs_with_baselines.hrv_mean_60d AS hrv_mean_60d,
    inputs_with_baselines.hrv_sd_60d AS hrv_sd_60d,
    inputs_with_baselines.rhr_mean_60d AS rhr_mean_60d,
    inputs_with_baselines.rhr_sd_60d AS rhr_sd_60d,
    if(inputs_with_baselines.user_id IS NULL, 1, 0) AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM result_keys
LEFT JOIN inputs_with_baselines
    ON inputs_with_baselines.user_id = result_keys.user_id
    AND inputs_with_baselines.date = result_keys.date
CROSS JOIN refresh_clock
