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
    FROM {{ this }} FINAL
),

changed_users AS (
    SELECT DISTINCT user_id
    FROM {{ ref('daily_activity_load') }} FINAL
    WHERE refreshed_at > (SELECT last_refreshed_at FROM target_state)
),
{% endif %}

activity_load AS (
    SELECT
        user_id,
        toDate(started_at) AS date,
        coalesce(sum(daily_load), 0) AS daily_load
    FROM {{ ref('daily_activity_load') }} FINAL
    WHERE is_deleted = 0
        AND started_at IS NOT NULL
        {% if is_incremental() %}
        AND user_id IN (SELECT user_id FROM changed_users)
        {% endif %}
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
        activity_users.first_activity_date AS calculation_min_date,
        activity_users.first_activity_date AS output_min_date,
        greatest(activity_users.latest_activity_date, today()) AS max_date
    FROM activity_users
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

current_rows AS (
    SELECT
        with_windows.user_id AS user_id,
        with_windows.date AS date,
        with_windows.daily_load AS daily_load,
        least(21, round(2.775 * log(1 + greatest(with_windows.daily_load, 0)), 1)) AS strain,
        with_windows.acute_load_7d AS acute_load_7d,
        with_windows.chronic_load_28d AS chronic_load_28d,
        if(
            with_windows.chronic_load_28d > 0 AND with_windows.chronic_count = 28,
            with_windows.acute_load_7d / with_windows.chronic_load_28d,
            NULL
        ) AS workload_ratio
    FROM with_windows
    INNER JOIN date_bounds
        ON date_bounds.user_id = with_windows.user_id
    WHERE with_windows.date >= date_bounds.output_min_date
),

{% if is_incremental() %}
existing_keys AS (
    SELECT DISTINCT
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
    FROM current_rows
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
        now64(9) AS refreshed_at
)

SELECT
    CAST(result_keys.user_id, 'UUID') AS user_id,
    CAST(result_keys.date, 'Date') AS date,
    coalesce(current_rows.daily_load, 0) AS daily_load,
    coalesce(current_rows.strain, 0) AS strain,
    coalesce(current_rows.acute_load_7d, 0) AS acute_load_7d,
    coalesce(current_rows.chronic_load_28d, 0) AS chronic_load_28d,
    current_rows.workload_ratio AS workload_ratio,
    if(current_rows.user_id IS NULL, 1, 0) AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM result_keys
LEFT JOIN current_rows
    ON current_rows.user_id = result_keys.user_id
    AND current_rows.date = result_keys.date
CROSS JOIN refresh_clock
