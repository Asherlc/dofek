{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1
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

activity_bounds AS (
    SELECT
        activity_id,
        user_id,
        canonical_type,
        started_at,
        ended_at,
        avg_hr
    FROM {{ ref('activity_summary_rows') }} FINAL
        {% if is_incremental() %}
        INNER JOIN changed_activity_keys USING (activity_id, user_id)
        {% endif %}
    WHERE is_deleted = 0
        AND ended_at IS NOT NULL
        AND avg_hr IS NOT NULL
        AND avg_hr > 0
),

{% if is_incremental() %}
existing_activities AS (
    SELECT DISTINCT
        activity_id,
        user_id
    FROM {{ this }} FINAL
    INNER JOIN changed_activity_keys USING (activity_id, user_id)
    WHERE is_deleted = 0
),
{% endif %}

activity_keys AS (
    SELECT
        activity_id,
        user_id
    FROM activity_bounds
    {% if is_incremental() %}
    UNION DISTINCT
    SELECT
        activity_id,
        user_id
    FROM existing_activities
    {% endif %}
),

resting_by_activity AS (
    SELECT
        activity_bounds.activity_id AS activity_id,
        activity_bounds.user_id AS user_id,
        argMax(resting.resting_hr, resting.ended_at) AS resting_hr
    FROM activity_bounds
    INNER JOIN {{ ref('resting_heart_rate_sleep_window') }} AS resting FINAL
        ON resting.user_id = activity_bounds.user_id
        AND toDate(resting.ended_at) <= toDate(activity_bounds.started_at)
    WHERE resting.is_deleted = 0
        AND resting.ended_at IS NOT NULL
        AND resting.resting_hr IS NOT NULL
    GROUP BY
        activity_bounds.activity_id,
        activity_bounds.user_id
),

activity_load AS (
    SELECT
        activity_bounds.activity_id AS activity_id,
        activity_bounds.user_id AS user_id,
        activity_bounds.started_at AS started_at,
        activity_bounds.ended_at AS ended_at,
        toDate(activity_bounds.started_at) AS date,
        dateDiff('second', activity_bounds.started_at, activity_bounds.ended_at) / 60.0 AS duration_minutes,
        activity_bounds.avg_hr AS avg_hr,
        user_profile.max_hr AS max_hr,
        coalesce(resting_by_activity.resting_hr, nullIf(user_profile.resting_hr, 0), 60) AS resting_hr
    FROM activity_bounds
    INNER JOIN {{ source('postgres_fitness', 'user_profile_current') }} AS user_profile
        ON user_profile.id = activity_bounds.user_id
    LEFT JOIN resting_by_activity
        ON resting_by_activity.activity_id = activity_bounds.activity_id
        AND resting_by_activity.user_id = activity_bounds.user_id
    WHERE activity_bounds.canonical_type IN (
            'cycling',
            'running',
            'swimming',
            'walking',
            'hiking'
        )
        AND user_profile.max_hr IS NOT NULL
),

training_load AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        ended_at,
        date,
        if(max_hr > resting_hr AND avg_hr > resting_hr,
            duration_minutes
            * intensity
            * 0.64 * exp(1.92 * intensity)
            / (60.0 * 0.85 * 0.64 * exp(1.92 * 0.85))
            * 100,
            0
        ) AS training_load
    FROM (
        SELECT
            activity_id,
            user_id,
            started_at,
            ended_at,
            date,
            duration_minutes,
            avg_hr,
            max_hr,
            resting_hr,
            if(
                max_hr > resting_hr,
                toFloat64(avg_hr - resting_hr) / toFloat64(max_hr - resting_hr),
                0
            ) AS intensity
        FROM activity_load
    )
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    activity_keys.activity_id AS activity_id,
    activity_keys.user_id AS user_id,
    training_load.started_at AS started_at,
    training_load.ended_at AS ended_at,
    training_load.date AS date,
    coalesce(training_load.training_load, 0) AS training_load,
    if(training_load.activity_id IS NULL, 1, 0) AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM activity_keys
LEFT JOIN training_load
    ON training_load.activity_id = activity_keys.activity_id
    AND training_load.user_id = activity_keys.user_id
CROSS JOIN refresh_clock
