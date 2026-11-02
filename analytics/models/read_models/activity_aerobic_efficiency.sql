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
    INNER JOIN {{ source('postgres_fitness', 'user_profile_current') }} AS user_profile
        ON user_profile.id = activity_bounds.user_id
    LEFT JOIN resting_by_activity
        ON resting_by_activity.activity_id = activity_bounds.activity_id
    WHERE user_profile.max_hr IS NOT NULL
),

heart_rate_samples AS (
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
        leadInFrame(hr.recorded_at, 1, hr.recorded_at) OVER (
            PARTITION BY am.user_id, am.activity_id
            ORDER BY hr.recorded_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS next_recorded_at,
        hr.scalar AS heart_rate
    FROM activity_meta AS am
    INNER JOIN {{ ref('activity_sensor_sample') }} AS hr FINAL
        ON hr.activity_id = am.activity_id
        AND hr.user_id = am.user_id
        AND hr.channel = 'heart_rate'
        AND hr.is_deleted = 0
    WHERE (am.user_id, am.activity_id) IN (
        SELECT
            user_id,
            activity_id
        FROM z2_power_samples
    )
),

z2_heart_rate_samples AS (
    SELECT *
    FROM heart_rate_samples
    WHERE heart_rate >= resting_hr + (max_hr - resting_hr) * 0.6
        AND heart_rate < resting_hr + (max_hr - resting_hr) * 0.7
    ORDER BY
        user_id,
        activity_id,
        recorded_at
),

z2_power_samples AS (
    SELECT
        activity_id,
        user_id,
        recorded_at,
        leadInFrame(recorded_at, 1, recorded_at + INTERVAL 10 SECOND) OVER (
            PARTITION BY user_id, activity_id
            ORDER BY recorded_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS next_recorded_at,
        scalar
    FROM {{ ref('activity_sensor_sample') }} FINAL
    WHERE channel = 'power'
        AND is_deleted = 0
        AND (user_id, activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM activity_meta
        )
    ORDER BY
        user_id,
        activity_id,
        recorded_at
),

-- Split at either channel's updates so independently sampled streams retain all paired time.
sample_events AS (
    SELECT
        activity_id,
        user_id,
        recorded_at,
        leadInFrame(recorded_at, 1, recorded_at) OVER (
            PARTITION BY user_id, activity_id
            ORDER BY recorded_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS next_recorded_at
    FROM (
        SELECT
            activity_id,
            user_id,
            recorded_at
        FROM heart_rate_samples
        UNION DISTINCT
        SELECT
            activity_id,
            user_id,
            recorded_at
        FROM z2_power_samples
    )
),

paired_intervals AS (
    -- Match the cycling signal policy's ten-second maximum hold for both channels.
    SELECT
        hr.activity_id AS activity_id,
        hr.user_id AS user_id,
        hr.canonical_type AS canonical_type,
        hr.name AS name,
        hr.started_at AS started_at,
        hr.ended_at AS ended_at,
        hr.max_hr AS max_hr,
        hr.resting_hr AS resting_hr,
        hr.recorded_at AS heart_rate_recorded_at,
        hr.heart_rate AS heart_rate,
        pwr.scalar AS power,
        greatest(0, dateDiff(
            'microsecond',
            events.recorded_at,
            least(events.next_recorded_at, hr.next_recorded_at, hr.ended_at, pwr.next_recorded_at,
                hr.recorded_at + INTERVAL 10 SECOND, pwr.recorded_at + INTERVAL 10 SECOND)
        ) / 1000000.0) AS paired_seconds
    FROM sample_events AS events
    ASOF JOIN z2_heart_rate_samples AS hr
        ON events.user_id = hr.user_id
        AND events.activity_id = hr.activity_id
        AND events.recorded_at >= hr.recorded_at
    ASOF JOIN z2_power_samples AS pwr
        ON events.user_id = pwr.user_id
        AND events.activity_id = pwr.activity_id
        AND events.recorded_at >= pwr.recorded_at
    WHERE pwr.scalar > 0
),

z2_samples AS (
    SELECT
        activity_id,
        user_id,
        any(canonical_type) AS canonical_type,
        any(name) AS name,
        any(started_at) AS started_at,
        any(ended_at) AS ended_at,
        any(max_hr) AS max_hr,
        any(resting_hr) AS resting_hr,
        round(sum(power * paired_seconds) / sum(paired_seconds), 1) AS avg_power_z2,
        round(sum(heart_rate * paired_seconds) / sum(paired_seconds), 1) AS avg_hr_z2,
        round(sum(power * paired_seconds) / sum(heart_rate * paired_seconds), 3) AS efficiency_factor,
        toInt32(uniqExact(heart_rate_recorded_at)) AS z2_samples
    FROM paired_intervals
    WHERE paired_seconds > 0
    GROUP BY
        activity_id,
        user_id
    HAVING sum(paired_seconds) >= 300
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
