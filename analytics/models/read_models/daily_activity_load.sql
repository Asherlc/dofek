{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
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

changed_activity_keys AS (
    SELECT DISTINCT
        activity_id,
        user_id
    FROM {{ ref('activity_summary_rows') }} FINAL
    WHERE refreshed_at > (SELECT last_refreshed_at FROM target_state)
),
{% endif %}

activity_load AS (
    SELECT
        activity_summary.activity_id AS activity_id,
        activity_summary.user_id AS user_id,
        activity_summary.started_at AS started_at,
        activity_summary.ended_at AS ended_at,
        dateDiff('second', activity_summary.started_at, activity_summary.ended_at) / 60.0
        * activity_summary.avg_hr / nullIf(toFloat64(activity_summary.max_hr), 0) AS daily_load
    FROM {{ ref('activity_summary_rows') }} AS activity_summary FINAL
        {% if is_incremental() %}
        INNER JOIN changed_activity_keys USING (activity_id, user_id)
        {% endif %}
    WHERE activity_summary.is_deleted = 0
        AND activity_summary.ended_at IS NOT NULL
        AND activity_summary.avg_hr IS NOT NULL
),

{% if is_incremental() %}
existing_activities AS (
    SELECT
        existing.activity_id AS activity_id,
        existing.user_id AS user_id,
        existing.started_at AS started_at,
        existing.ended_at AS ended_at,
        existing.daily_load AS daily_load
    FROM {{ this }} AS existing FINAL
    INNER JOIN changed_activity_keys USING (activity_id, user_id)
    WHERE existing.is_deleted = 0
),
{% endif %}

activity_keys AS (
    SELECT
        activity_id,
        user_id
    FROM activity_load
    {% if is_incremental() %}
    UNION DISTINCT
    SELECT
        activity_id,
        user_id
    FROM existing_activities
    {% endif %}
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    activity_keys.activity_id AS activity_id,
    activity_keys.user_id AS user_id,
    coalesce(activity_load.started_at, existing_activities.started_at) AS started_at,
    coalesce(activity_load.ended_at, existing_activities.ended_at) AS ended_at,
    coalesce(activity_load.daily_load, existing_activities.daily_load) AS daily_load,
    if(activity_load.activity_id IS NULL, 1, 0) AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM activity_keys
LEFT JOIN activity_load
    ON activity_load.activity_id = activity_keys.activity_id
    AND activity_load.user_id = activity_keys.user_id
{% if is_incremental() %}
LEFT JOIN existing_activities
    ON existing_activities.activity_id = activity_keys.activity_id
    AND existing_activities.user_id = activity_keys.user_id
{% else %}
LEFT JOIN activity_load AS existing_activities
    ON 0
{% endif %}
CROSS JOIN refresh_clock
