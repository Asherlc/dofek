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
        canonical_type,
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
        activity_bounds.canonical_type AS canonical_type,
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

z2_heart_rate_samples AS (
    SELECT
        am.activity_id AS activity_id,
        am.user_id AS user_id,
        am.canonical_type AS canonical_type,
        am.name AS name,
        am.started_at AS started_at,
        am.ended_at AS ended_at,
        am.max_hr AS max_hr,
        am.resting_hr AS resting_hr,
        hr.recorded_at AS recorded_at,
        hr.scalar AS heart_rate
    FROM activity_meta AS am
    INNER JOIN {{ ref('activity_sensor_sample') }} AS hr
        ON hr.activity_id = am.activity_id
        AND hr.user_id = am.user_id
        AND hr.channel = 'heart_rate'
        AND hr.is_deleted = 0
    WHERE hr.scalar >= am.resting_hr
            + (am.max_hr - am.resting_hr) * 0.6
        AND hr.scalar < am.resting_hr
            + (am.max_hr - am.resting_hr) * 0.7
    ORDER BY
        am.user_id,
        am.activity_id,
        hr.recorded_at
),

z2_power_samples AS (
    SELECT
        activity_id,
        user_id,
        recorded_at,
        scalar
    FROM {{ ref('activity_sensor_sample') }}
    WHERE channel = 'power'
        AND scalar > 0
        AND is_deleted = 0
    ORDER BY
        user_id,
        activity_id,
        recorded_at
),

z2_samples AS (
    SELECT
        hr.activity_id AS activity_id,
        hr.user_id AS user_id,
        any(hr.canonical_type) AS canonical_type,
        any(hr.name) AS name,
        any(hr.started_at) AS started_at,
        any(hr.ended_at) AS ended_at,
        any(hr.max_hr) AS max_hr,
        any(hr.resting_hr) AS resting_hr,
        round(avg(pwr.scalar), 1) AS avg_power_z2,
        round(avg(hr.heart_rate), 1) AS avg_hr_z2,
        CASE
            WHEN avg(hr.heart_rate) > 0
                THEN round(avg(pwr.scalar) / avg(hr.heart_rate), 3)
        END AS efficiency_factor,
        toInt32(count()) AS z2_samples
    FROM z2_heart_rate_samples AS hr
    ASOF JOIN z2_power_samples AS pwr
        ON hr.user_id = pwr.user_id
        AND hr.activity_id = pwr.activity_id
        AND hr.recorded_at >= pwr.recorded_at
    GROUP BY
        hr.activity_id,
        hr.user_id
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
    z2_samples.canonical_type AS canonical_type,
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
