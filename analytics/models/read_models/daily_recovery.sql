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
target_state AS (
    SELECT coalesce(max(refreshed_at), toDateTime64(0, 9, 'UTC')) AS last_refreshed_at
    FROM {{ this }}
),

changed_users AS (
    SELECT DISTINCT recovery_inputs.user_id AS user_id
    FROM {{ ref('daily_recovery_inputs') }} AS recovery_inputs FINAL
    WHERE recovery_inputs.refreshed_at > (SELECT last_refreshed_at FROM target_state)
),
{% endif %}

recovery_inputs AS (
    SELECT
        recovery_inputs.user_id AS user_id,
        recovery_inputs.date AS date,
        recovery_inputs.hrv AS hrv,
        recovery_inputs.resting_hr AS resting_hr,
        recovery_inputs.respiratory_rate AS respiratory_rate,
        recovery_inputs.efficiency_pct AS efficiency_pct,
        recovery_inputs.hrv_mean_30d AS hrv_mean_30d,
        recovery_inputs.hrv_sd_30d AS hrv_sd_30d,
        recovery_inputs.hrv_baseline_sample_count AS hrv_baseline_sample_count,
        recovery_inputs.hrv_baseline_coverage AS hrv_baseline_coverage,
        recovery_inputs.hrv_mean_7d AS hrv_mean_7d,
        recovery_inputs.hrv_mean_previous_28d AS hrv_mean_previous_28d,
        recovery_inputs.rhr_mean_30d AS rhr_mean_30d,
        recovery_inputs.rhr_sd_30d AS rhr_sd_30d,
        recovery_inputs.rhr_baseline_sample_count AS rhr_baseline_sample_count,
        recovery_inputs.rhr_baseline_coverage AS rhr_baseline_coverage,
        recovery_inputs.rhr_mean_7d AS rhr_mean_7d,
        recovery_inputs.rhr_mean_previous_28d AS rhr_mean_previous_28d,
        recovery_inputs.rr_mean_30d AS rr_mean_30d,
        recovery_inputs.rr_sd_30d AS rr_sd_30d,
        recovery_inputs.rr_baseline_sample_count AS rr_baseline_sample_count,
        recovery_inputs.rr_baseline_coverage AS rr_baseline_coverage,
        recovery_inputs.rr_mean_7d AS rr_mean_7d,
        recovery_inputs.rr_mean_previous_28d AS rr_mean_previous_28d,
        recovery_inputs.efficiency_mean_30d AS efficiency_mean_30d,
        recovery_inputs.efficiency_sd_30d AS efficiency_sd_30d,
        recovery_inputs.efficiency_baseline_sample_count AS efficiency_baseline_sample_count,
        recovery_inputs.efficiency_baseline_coverage AS efficiency_baseline_coverage,
        recovery_inputs.efficiency_mean_7d AS efficiency_mean_7d,
        recovery_inputs.efficiency_mean_previous_28d AS efficiency_mean_previous_28d,
        recovery_inputs.hrv_mean_60d AS hrv_mean_60d,
        recovery_inputs.hrv_sd_60d AS hrv_sd_60d,
        recovery_inputs.rhr_mean_60d AS rhr_mean_60d,
        recovery_inputs.rhr_sd_60d AS rhr_sd_60d
    FROM {{ ref('daily_recovery_inputs') }} AS recovery_inputs FINAL
    WHERE recovery_inputs.is_deleted = 0
        {% if is_incremental() %}
        AND user_id IN (SELECT user_id FROM changed_users)
        {% endif %}
),

baseline_metrics AS (
    SELECT
        *,
        if(
            hrv IS NOT NULL AND hrv_mean_30d IS NOT NULL AND hrv_sd_30d IS NOT NULL AND hrv_sd_30d > 0,
            (hrv - hrv_mean_30d) / hrv_sd_30d,
            CAST(NULL, 'Nullable(Float64)')
        ) AS hrv_z_score,
        if(
            resting_hr IS NOT NULL AND rhr_mean_30d IS NOT NULL AND rhr_sd_30d IS NOT NULL AND rhr_sd_30d > 0,
            (resting_hr - rhr_mean_30d) / rhr_sd_30d,
            CAST(NULL, 'Nullable(Float64)')
        ) AS resting_hr_z_score,
        if(
            respiratory_rate IS NOT NULL AND rr_mean_30d IS NOT NULL AND rr_sd_30d IS NOT NULL AND rr_sd_30d > 0,
            (respiratory_rate - rr_mean_30d) / rr_sd_30d,
            CAST(NULL, 'Nullable(Float64)')
        ) AS respiratory_rate_z_score,
        if(
            efficiency_pct IS NOT NULL
                AND efficiency_mean_30d IS NOT NULL
                AND efficiency_sd_30d IS NOT NULL
                AND efficiency_sd_30d > 0,
            (efficiency_pct - efficiency_mean_30d) / efficiency_sd_30d,
            CAST(NULL, 'Nullable(Float64)')
        ) AS efficiency_z_score
    FROM recovery_inputs
),

{% if is_incremental() %}
existing_keys AS (
    SELECT
        user_id,
        date
    FROM {{ this }} FINAL
    WHERE is_deleted = 0
        AND user_id IN (SELECT user_id FROM changed_users)
),
{% endif %}

result_keys AS (
    SELECT
        user_id,
        date
    FROM baseline_metrics
    {% if is_incremental() %}
    UNION DISTINCT
    SELECT
        user_id,
        date
    FROM existing_keys
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
    baseline_metrics.hrv AS hrv,
    baseline_metrics.resting_hr AS resting_hr,
    baseline_metrics.respiratory_rate AS respiratory_rate,
    baseline_metrics.efficiency_pct AS efficiency_pct,
    baseline_metrics.hrv_mean_30d AS hrv_mean_30d,
    baseline_metrics.hrv_sd_30d AS hrv_sd_30d,
    baseline_metrics.hrv_z_score AS hrv_z_score,
    baseline_metrics.hrv_baseline_sample_count AS hrv_baseline_sample_count,
    baseline_metrics.hrv_baseline_coverage AS hrv_baseline_coverage,
    baseline_metrics.hrv_mean_7d AS hrv_mean_7d,
    baseline_metrics.hrv_mean_previous_28d AS hrv_mean_previous_28d,
    baseline_metrics.rhr_mean_30d AS rhr_mean_30d,
    baseline_metrics.rhr_sd_30d AS rhr_sd_30d,
    baseline_metrics.resting_hr_z_score AS resting_hr_z_score,
    baseline_metrics.rhr_baseline_sample_count AS rhr_baseline_sample_count,
    baseline_metrics.rhr_baseline_coverage AS rhr_baseline_coverage,
    baseline_metrics.rhr_mean_7d AS rhr_mean_7d,
    baseline_metrics.rhr_mean_previous_28d AS rhr_mean_previous_28d,
    baseline_metrics.rr_mean_30d AS rr_mean_30d,
    baseline_metrics.rr_sd_30d AS rr_sd_30d,
    baseline_metrics.respiratory_rate_z_score AS respiratory_rate_z_score,
    baseline_metrics.rr_baseline_sample_count AS rr_baseline_sample_count,
    baseline_metrics.rr_baseline_coverage AS rr_baseline_coverage,
    baseline_metrics.rr_mean_7d AS rr_mean_7d,
    baseline_metrics.rr_mean_previous_28d AS rr_mean_previous_28d,
    baseline_metrics.efficiency_mean_30d AS efficiency_mean_30d,
    baseline_metrics.efficiency_sd_30d AS efficiency_sd_30d,
    baseline_metrics.efficiency_z_score AS efficiency_z_score,
    baseline_metrics.efficiency_baseline_sample_count AS efficiency_baseline_sample_count,
    baseline_metrics.efficiency_baseline_coverage AS efficiency_baseline_coverage,
    baseline_metrics.efficiency_mean_7d AS efficiency_mean_7d,
    baseline_metrics.efficiency_mean_previous_28d AS efficiency_mean_previous_28d,
    baseline_metrics.hrv_mean_60d AS hrv_mean_60d,
    baseline_metrics.hrv_sd_60d AS hrv_sd_60d,
    baseline_metrics.rhr_mean_60d AS rhr_mean_60d,
    baseline_metrics.rhr_sd_60d AS rhr_sd_60d,
    if(baseline_metrics.user_id IS NULL, 1, 0) AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM result_keys
LEFT JOIN baseline_metrics
    ON baseline_metrics.user_id = result_keys.user_id
    AND baseline_metrics.date = result_keys.date
CROSS JOIN refresh_clock
