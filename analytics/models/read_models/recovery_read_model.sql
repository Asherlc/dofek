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
        max(date) AS latest_materialized_date,
        max(refreshed_at) AS latest_materialized_refreshed_at
    FROM {{ this }}
    GROUP BY user_id
),
{% endif %}

recovery_inputs AS (
    SELECT
        user_id,
        date,
        hrv,
        resting_hr,
        respiratory_rate,
        efficiency_pct,
        hrv_mean_30d,
        hrv_sd_30d,
        rhr_mean_30d,
        rhr_sd_30d,
        rr_mean_30d,
        rr_sd_30d,
        hrv_mean_60d,
        hrv_sd_60d,
        rhr_mean_60d,
        rhr_sd_60d,
        refreshed_at
    FROM {{ ref('daily_recovery_inputs') }} FINAL
),

recovery_inputs_to_materialize AS (
    SELECT
        recovery_inputs.user_id AS user_id,
        recovery_inputs.date AS date,
        recovery_inputs.hrv AS hrv,
        recovery_inputs.resting_hr AS resting_hr,
        recovery_inputs.respiratory_rate AS respiratory_rate,
        recovery_inputs.efficiency_pct AS efficiency_pct,
        recovery_inputs.hrv_mean_30d AS hrv_mean_30d,
        recovery_inputs.hrv_sd_30d AS hrv_sd_30d,
        recovery_inputs.rhr_mean_30d AS rhr_mean_30d,
        recovery_inputs.rhr_sd_30d AS rhr_sd_30d,
        recovery_inputs.rr_mean_30d AS rr_mean_30d,
        recovery_inputs.rr_sd_30d AS rr_sd_30d,
        recovery_inputs.hrv_mean_60d AS hrv_mean_60d,
        recovery_inputs.hrv_sd_60d AS hrv_sd_60d,
        recovery_inputs.rhr_mean_60d AS rhr_mean_60d,
        recovery_inputs.rhr_sd_60d AS rhr_sd_60d
    FROM recovery_inputs
    {% if is_incremental() %}
    LEFT JOIN existing_dates
        ON existing_dates.user_id = recovery_inputs.user_id
    WHERE existing_dates.user_id IS NULL
        OR recovery_inputs.refreshed_at > existing_dates.latest_materialized_refreshed_at
        OR recovery_inputs.date >= existing_dates.latest_materialized_date - INTERVAL 60 DAY
    {% endif %}
),

scored AS (
    SELECT
        *,
        if(
            hrv IS NOT NULL AND hrv_mean_30d IS NOT NULL AND hrv_sd_30d IS NOT NULL AND hrv_sd_30d > 0,
            (hrv - hrv_mean_30d) / hrv_sd_30d,
            CAST(NULL, 'Nullable(Float64)')
        ) AS hrv_z_score,
        if(
            resting_hr IS NOT NULL AND rhr_mean_30d IS NOT NULL AND rhr_sd_30d IS NOT NULL AND rhr_sd_30d > 0,
            -1 * ((resting_hr - rhr_mean_30d) / rhr_sd_30d),
            CAST(NULL, 'Nullable(Float64)')
        ) AS resting_hr_z_score,
        if(
            respiratory_rate IS NOT NULL AND rr_mean_30d IS NOT NULL AND rr_sd_30d IS NOT NULL AND rr_sd_30d > 0,
            -1 * ((respiratory_rate - rr_mean_30d) / rr_sd_30d),
            CAST(NULL, 'Nullable(Float64)')
        ) AS respiratory_rate_z_score,
        if(
            efficiency_pct IS NOT NULL,
            least(100, greatest(0, round(efficiency_pct))),
            62
        ) AS sleep_score
    FROM recovery_inputs_to_materialize
),

sigmoid_inputs AS (
    SELECT
        *,
        if(hrv_z_score IS NULL, CAST(NULL, 'Nullable(Float64)'), 1 / (1 + exp(-hrv_z_score * 1.1))) AS hrv_sigmoid,
        if(resting_hr_z_score IS NULL, CAST(NULL, 'Nullable(Float64)'), 1 / (1 + exp(-resting_hr_z_score * 1.1))) AS resting_hr_sigmoid,
        if(respiratory_rate_z_score IS NULL, CAST(NULL, 'Nullable(Float64)'), 1 / (1 + exp(-respiratory_rate_z_score * 1.1))) AS respiratory_rate_sigmoid
    FROM scored
),

sigmoid_scores AS (
    SELECT
        *,
        if(
            hrv_sigmoid IS NULL,
            62,
            least(100, greatest(0, round(if(
                hrv_sigmoid >= 0.5,
                62 + 38 * ((hrv_sigmoid - 0.5) / 0.5),
                62 - 62 * ((0.5 - hrv_sigmoid) / 0.5)
            ))))
        ) AS hrv_score,
        if(
            resting_hr_sigmoid IS NULL,
            62,
            least(100, greatest(0, round(if(
                resting_hr_sigmoid >= 0.5,
                62 + 38 * ((resting_hr_sigmoid - 0.5) / 0.5),
                62 - 62 * ((0.5 - resting_hr_sigmoid) / 0.5)
            ))))
        ) AS resting_hr_score,
        if(
            respiratory_rate_sigmoid IS NULL,
            62,
            least(100, greatest(0, round(if(
                respiratory_rate_sigmoid >= 0.5,
                62 + 38 * ((respiratory_rate_sigmoid - 0.5) / 0.5),
                62 - 62 * ((0.5 - respiratory_rate_sigmoid) / 0.5)
            ))))
        ) AS respiratory_rate_score
    FROM sigmoid_inputs
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    CAST(user_id, 'UUID') AS user_id,
    CAST(date, 'Date') AS date,
    hrv,
    resting_hr,
    respiratory_rate,
    efficiency_pct,
    hrv_mean_30d,
    hrv_sd_30d,
    rhr_mean_30d,
    rhr_sd_30d,
    rr_mean_30d,
    rr_sd_30d,
    hrv_mean_60d,
    hrv_sd_60d,
    rhr_mean_60d,
    rhr_sd_60d,
    hrv_score,
    resting_hr_score,
    sleep_score,
    respiratory_rate_score,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM sigmoid_scores
CROSS JOIN refresh_clock
