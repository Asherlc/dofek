{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, week)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

WITH changed_users AS (
    SELECT DISTINCT user_id
    FROM {{ ref('daily_endurance_load') }} FINAL
    {% if is_incremental() %}
    WHERE refreshed_at >= (
            SELECT coalesce(max(refreshed_at), toDateTime64(0, 9, 'UTC'))
            FROM {{ this }} FINAL
        )
    {% endif %}
),

daily_load AS (
    SELECT
        user_id,
        assumeNotNull(date) AS load_date,
        sum(training_load) AS training_load
    FROM {{ ref('daily_endurance_load') }} FINAL
    WHERE is_deleted = 0
        AND date IS NOT NULL
        AND user_id IN (SELECT user_id FROM changed_users)
    GROUP BY
        user_id,
        load_date
),

date_bounds AS (
    SELECT
        user_id,
        min(load_date) AS first_load_date,
        max(load_date) AS latest_load_date
    FROM daily_load
    GROUP BY user_id
),

date_series AS (
    SELECT
        user_id,
        first_load_date + INTERVAL date_offset DAY AS date
    FROM date_bounds
    ARRAY JOIN range(
        toUInt32(dateDiff('day', first_load_date, latest_load_date) + 1)
    ) AS date_offset
),

ctl_by_date AS (
    SELECT
        date_series.user_id AS user_id,
        date_series.date AS date,
        sum(
            daily_load.training_load
            * (1.0 / 42.0)
            * pow(41.0 / 42.0, dateDiff('day', daily_load.load_date, date_series.date))
        ) AS ctl
    FROM date_series
    LEFT JOIN daily_load
        ON daily_load.user_id = date_series.user_id
        AND daily_load.load_date <= date_series.date
    GROUP BY
        date_series.user_id,
        date_series.date
),

weekly_ctl AS (
    SELECT
        user_id,
        toMonday(date) AS week,
        argMax(ctl, date) AS ctl_end
    FROM ctl_by_date
    GROUP BY
        user_id,
        toMonday(date)
),

weekly_with_previous AS (
    SELECT
        user_id,
        week,
        ctl_end,
        lagInFrame(toNullable(ctl_end), 1, CAST(NULL, 'Nullable(Float64)')) OVER (
            PARTITION BY user_id ORDER BY week
        ) AS previous_ctl_end
    FROM weekly_ctl
),

current_rows AS (
    SELECT
        weekly_with_previous.user_id AS user_id,
        weekly_with_previous.week AS week,
        round(weekly_with_previous.previous_ctl_end, 2) AS ctl_start,
        round(weekly_with_previous.ctl_end, 2) AS ctl_end,
        round(weekly_with_previous.ctl_end - weekly_with_previous.previous_ctl_end, 2) AS ramp_rate
    FROM weekly_with_previous
    WHERE weekly_with_previous.previous_ctl_end IS NOT NULL
),

{% if is_incremental() %}
existing_keys AS (
    SELECT DISTINCT
        user_id,
        week
    FROM {{ this }} FINAL
    WHERE is_deleted = 0
        AND user_id IN (SELECT user_id FROM changed_users)
),
{% endif %}

result_keys AS (
    SELECT
        user_id,
        week
    FROM current_rows
    {% if is_incremental() %}
    UNION DISTINCT
    SELECT
        user_id,
        week
    FROM existing_keys
    {% endif %}
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    result_keys.user_id AS user_id,
    result_keys.week AS week,
    coalesce(current_rows.ctl_start, 0) AS ctl_start,
    coalesce(current_rows.ctl_end, 0) AS ctl_end,
    coalesce(current_rows.ramp_rate, 0) AS ramp_rate,
    if(current_rows.user_id IS NULL, 1, 0) AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM result_keys
LEFT JOIN current_rows
    ON current_rows.user_id = result_keys.user_id
    AND current_rows.week = result_keys.week
CROSS JOIN refresh_clock
