{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, week)',
    query_settings={
        'max_threads': 1
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

week_bounds AS (
    SELECT
        user_id,
        toMonday(min(load_date)) AS first_week,
        toMonday(max(load_date)) AS latest_week
    FROM daily_load
    GROUP BY user_id
),

calendar_dates AS (
    SELECT
        user_id,
        first_week + INTERVAL date_offset DAY AS load_date
    FROM week_bounds
    ARRAY JOIN range(toUInt32(dateDiff('day', first_week, latest_week + INTERVAL 6 DAY) + 1)) AS date_offset
),

load_by_calendar_date AS (
    SELECT
        calendar_dates.user_id AS user_id,
        calendar_dates.load_date AS load_date,
        coalesce(daily_load.training_load, 0) AS training_load
    FROM calendar_dates
    LEFT JOIN daily_load
        ON daily_load.user_id = calendar_dates.user_id
        AND daily_load.load_date = calendar_dates.load_date
),

weekly_stats AS (
    SELECT
        user_id,
        toMonday(load_date) AS week,
        avg(training_load) AS mean_load,
        stddevPop(training_load) AS stdev_load,
        sum(training_load) AS weekly_load
    FROM load_by_calendar_date
    GROUP BY
        user_id,
        toMonday(load_date)
    HAVING stddevPop(training_load) > 1e-6
),

current_rows AS (
    SELECT
        user_id,
        week,
        round(mean_load / stdev_load, 2) AS monotony,
        round(weekly_load * (mean_load / stdev_load), 1) AS strain,
        round(weekly_load, 1) AS weekly_load
    FROM weekly_stats
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
    coalesce(current_rows.monotony, 0) AS monotony,
    coalesce(current_rows.strain, 0) AS strain,
    coalesce(current_rows.weekly_load, 0) AS weekly_load,
    if(current_rows.user_id IS NULL, 1, 0) AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM result_keys
LEFT JOIN current_rows
    ON current_rows.user_id = result_keys.user_id
    AND current_rows.week = result_keys.week
CROSS JOIN refresh_clock
