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
        max(date) AS latest_materialized_date
    FROM {{ this }}
    GROUP BY user_id
),
{% endif %}

activity_load AS (
    SELECT
        user_id,
        toDate(started_at) AS date,
        coalesce(sum(daily_load), 0) AS daily_load
    FROM {{ ref('daily_activity_load') }} FINAL
    WHERE started_at IS NOT NULL
    GROUP BY user_id, toDate(started_at)
),

activity_users AS (
    SELECT
        user_id,
        min(date) AS first_activity_date,
        max(date) AS latest_activity_date
    FROM activity_load
    GROUP BY user_id
),

date_bounds AS (
    SELECT
        activity_users.user_id AS user_id,
        {% if is_incremental() %}
        if(
            existing_dates.latest_materialized_date IS NULL,
            activity_users.first_activity_date,
            greatest(
                activity_users.first_activity_date,
                existing_dates.latest_materialized_date - INTERVAL 54 DAY
            )
        ) AS calculation_min_date,
        if(
            existing_dates.latest_materialized_date IS NULL,
            activity_users.first_activity_date,
            greatest(
                activity_users.first_activity_date,
                existing_dates.latest_materialized_date - INTERVAL 27 DAY
            )
        ) AS output_min_date,
        {% else %}
        activity_users.first_activity_date AS calculation_min_date,
        activity_users.first_activity_date AS output_min_date,
        {% endif %}
        greatest(activity_users.latest_activity_date, today()) AS max_date
    FROM activity_users
    {% if is_incremental() %}
    LEFT JOIN existing_dates
        ON existing_dates.user_id = activity_users.user_id
    {% endif %}
),

date_series AS (
    SELECT
        user_id,
        calculation_min_date + INTERVAL date_offset DAY AS date
    FROM date_bounds
    ARRAY JOIN range(
        toUInt32(dateDiff('day', calculation_min_date, max_date) + 1)
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
    CAST(with_windows.user_id, 'UUID') AS user_id,
    CAST(with_windows.date, 'Date') AS date,
    with_windows.daily_load AS daily_load,
    least(21, round(2.775 * log(1 + greatest(with_windows.daily_load, 0)), 1)) AS strain,
    with_windows.acute_load_7d AS acute_load_7d,
    with_windows.chronic_load_28d AS chronic_load_28d,
    if(
        with_windows.chronic_load_28d > 0 AND with_windows.chronic_count = 28,
        with_windows.acute_load_7d / with_windows.chronic_load_28d,
        NULL
    ) AS workload_ratio,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM with_windows
INNER JOIN date_bounds
    ON date_bounds.user_id = with_windows.user_id
CROSS JOIN refresh_clock
WHERE with_windows.date >= date_bounds.output_min_date
