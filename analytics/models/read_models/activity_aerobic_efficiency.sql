{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH activity_bounds AS (
    SELECT
        activity_id,
        user_id,
        activity_type,
        name,
        started_at,
        ended_at
    FROM {{ ref('activity_summary_rows') }} FINAL
    WHERE is_deleted = 0
        AND ended_at IS NOT NULL
),

{% if is_incremental() %}
existing_activities AS (
    SELECT DISTINCT
        activity_id,
        user_id
    FROM {{ this }} FINAL
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
        argMax(resting.resting_hr, toDate(resting.ended_at)) AS resting_hr
    FROM activity_bounds
    INNER JOIN {{ ref('resting_heart_rate_sleep_window') }} AS resting FINAL
        ON resting.user_id = activity_bounds.user_id
        AND toDate(resting.ended_at) <= toDate(activity_bounds.started_at)
    WHERE resting.is_deleted = 0
        AND resting.ended_at IS NOT NULL
        AND resting.resting_hr IS NOT NULL
    GROUP BY activity_bounds.activity_id
),

activity_meta AS (
    SELECT
        activity_bounds.activity_id AS activity_id,
        activity_bounds.user_id AS user_id,
        activity_bounds.activity_type AS activity_type,
        activity_bounds.name AS name,
        activity_bounds.started_at AS started_at,
        activity_bounds.ended_at AS ended_at,
        activity_bounds.started_at AS activity_date,
        user_profile.max_hr AS max_hr,
        coalesce(resting_by_activity.resting_hr, user_profile.resting_hr, 60) AS resting_hr
    FROM activity_bounds
    INNER JOIN postgres_fitness.user_profile_current AS user_profile
        ON user_profile.id = activity_bounds.user_id
    LEFT JOIN resting_by_activity
        ON resting_by_activity.activity_id = activity_bounds.activity_id
    WHERE user_profile.max_hr IS NOT NULL
),

z2_samples AS (
    SELECT
        am.activity_id AS activity_id,
        am.user_id AS user_id,
        any(am.activity_type) AS activity_type,
        any(am.name) AS name,
        any(am.started_at) AS started_at,
        any(am.ended_at) AS ended_at,
        any(am.max_hr) AS max_hr,
        any(am.resting_hr) AS resting_hr,
        round(avg(pwr.scalar), 1) AS avg_power_z2,
        round(avg(hr.scalar), 1) AS avg_hr_z2,
        CASE
            WHEN avg(hr.scalar) > 0
                THEN round(avg(pwr.scalar) / avg(hr.scalar), 3)
        END AS efficiency_factor,
        toInt32(count()) AS z2_samples
    FROM activity_meta AS am
    INNER JOIN {{ ref('activity_sensor_sample') }} AS hr
        ON hr.activity_id = am.activity_id
        AND hr.user_id = am.user_id
        AND hr.channel = 'heart_rate'
        AND hr.is_deleted = 0
    INNER JOIN {{ ref('activity_sensor_sample') }} AS pwr
        ON pwr.activity_id = am.activity_id
        AND pwr.user_id = am.user_id
        AND pwr.channel = 'power'
        AND pwr.recorded_at = hr.recorded_at
        AND pwr.scalar > 0
        AND pwr.is_deleted = 0
    WHERE hr.scalar >= am.resting_hr
            + (am.max_hr - am.resting_hr) * 0.6
        AND hr.scalar < am.resting_hr
            + (am.max_hr - am.resting_hr) * 0.7
    GROUP BY
        am.activity_id,
        am.user_id
    HAVING count() >= 300
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    activity_keys.activity_id AS activity_id,
    activity_keys.user_id AS user_id,
    z2_samples.activity_type AS activity_type,
    z2_samples.name AS name,
    z2_samples.started_at AS started_at,
    z2_samples.ended_at AS ended_at,
    z2_samples.max_hr AS max_hr,
    z2_samples.resting_hr AS resting_hr,
    coalesce(z2_samples.avg_power_z2, 0) AS avg_power_z2,
    coalesce(z2_samples.avg_hr_z2, 0) AS avg_hr_z2,
    coalesce(z2_samples.efficiency_factor, 0) AS efficiency_factor,
    coalesce(z2_samples.z2_samples, 0) AS z2_samples,
    if(z2_samples.activity_id IS NULL, 1, 0) AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM activity_keys
LEFT JOIN z2_samples
    ON z2_samples.activity_id = activity_keys.activity_id
    AND z2_samples.user_id = activity_keys.user_id
CROSS JOIN refresh_clock
