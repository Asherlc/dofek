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
        started_at,
        ended_at,
        dateDiff('second', started_at, ended_at) / 60.0 AS duration_minutes
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

activity_metadata AS (
    SELECT
        activity_bounds.activity_id AS activity_id,
        activity_bounds.user_id AS user_id,
        activity_bounds.started_at AS started_at,
        activity_bounds.ended_at AS ended_at,
        activity_bounds.duration_minutes AS duration_minutes,
        user_profile.max_hr AS max_hr,
        user_profile.ftp AS ftp,
        coalesce(resting_by_activity.resting_hr, user_profile.resting_hr) AS resting_hr
    FROM activity_bounds
    INNER JOIN {{ source('postgres_fitness', 'user_profile_current') }} AS user_profile
        ON user_profile.id = activity_bounds.user_id
    LEFT JOIN resting_by_activity
        ON resting_by_activity.activity_id = activity_bounds.activity_id
    WHERE user_profile.max_hr IS NOT NULL OR user_profile.ftp IS NOT NULL
),

sensor_counts AS (
    SELECT
        activity_metadata.activity_id AS activity_id,
        activity_metadata.user_id AS user_id,
        any(activity_metadata.started_at) AS started_at,
        any(activity_metadata.ended_at) AS ended_at,
        any(activity_metadata.duration_minutes) AS duration_minutes,
        any(activity_metadata.max_hr) AS max_hr,
        any(activity_metadata.ftp) AS ftp,
        any(activity_metadata.resting_hr) AS resting_hr,
        countIf(sensor_samples.channel = 'heart_rate') AS heart_rate_sample_count,
        countIf(sensor_samples.channel = 'power') AS power_sample_count,
        countIf(
            sensor_samples.channel = 'heart_rate'
            AND activity_metadata.resting_hr IS NOT NULL
            AND sensor_samples.scalar
                < activity_metadata.resting_hr
                + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.8
        ) AS aerobic_sample_count,
        countIf(
            sensor_samples.channel = 'heart_rate'
            AND activity_metadata.resting_hr IS NOT NULL
            AND sensor_samples.scalar
                >= activity_metadata.resting_hr
                + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.8
        ) AS heart_rate_high_intensity_sample_count,
        countIf(
            sensor_samples.channel = 'power'
            AND activity_metadata.ftp IS NOT NULL
            AND sensor_samples.scalar >= activity_metadata.ftp * 0.9
        ) AS power_high_intensity_sample_count
    FROM activity_metadata
    INNER JOIN {{ ref('activity_sensor_sample') }} AS sensor_samples
        ON sensor_samples.activity_id = activity_metadata.activity_id
        AND sensor_samples.user_id = activity_metadata.user_id
    WHERE sensor_samples.channel IN ('heart_rate', 'power')
        AND sensor_samples.scalar IS NOT NULL
        AND sensor_samples.is_deleted = 0
    GROUP BY activity_metadata.activity_id, activity_metadata.user_id
),

zone_minutes AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        ended_at,
        if(
            max_hr IS NOT NULL
            AND resting_hr IS NOT NULL
            AND heart_rate_sample_count > 0,
            toFloat64(aerobic_sample_count) / toFloat64(heart_rate_sample_count) * duration_minutes,
            0
        ) AS aerobic_minutes,
        greatest(
            if(
                max_hr IS NOT NULL
                AND resting_hr IS NOT NULL
                AND heart_rate_sample_count > 0,
                toFloat64(heart_rate_high_intensity_sample_count)
                    / toFloat64(heart_rate_sample_count) * duration_minutes,
                0
            ),
            if(
                ftp IS NOT NULL
                AND power_sample_count > 0,
                toFloat64(power_high_intensity_sample_count)
                    / toFloat64(power_sample_count) * duration_minutes,
                0
            )
        ) AS high_intensity_minutes
    FROM sensor_counts
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    activity_keys.activity_id AS activity_id,
    activity_keys.user_id AS user_id,
    zone_minutes.started_at AS started_at,
    zone_minutes.ended_at AS ended_at,
    coalesce(zone_minutes.aerobic_minutes, 0) AS aerobic_minutes,
    coalesce(zone_minutes.high_intensity_minutes, 0) AS high_intensity_minutes,
    if(zone_minutes.activity_id IS NULL, 1, 0) AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM activity_keys
LEFT JOIN zone_minutes
    ON zone_minutes.activity_id = activity_keys.activity_id
    AND zone_minutes.user_id = activity_keys.user_id
CROSS JOIN refresh_clock
