{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={'max_threads': 1, 'join_use_nulls': 1}
) }}

WITH activity_source_bounds AS (
    SELECT
activity_id,
user_id,
started_at,
ended_at,
refreshed_at
    FROM {{ ref('activity_summary_rows') }} FINAL
    WHERE is_deleted = 0 AND ended_at IS NOT NULL
),

{% if is_incremental() %}
resting_source_state AS (
    SELECT
        user_id,
        max(refreshed_at) AS refreshed_at
    FROM {{ ref('resting_heart_rate_sleep_window') }} FINAL
    GROUP BY user_id
),
{% endif %}

activity_bounds AS (
    SELECT
        bounds.activity_id AS activity_id,
        bounds.user_id AS user_id,
        bounds.started_at AS started_at,
        bounds.ended_at AS ended_at
    FROM activity_source_bounds AS bounds
    {% if is_incremental() %}
    LEFT JOIN {{ this }} AS previous FINAL
        ON previous.user_id = bounds.user_id AND previous.activity_id = bounds.activity_id
    LEFT JOIN {{ ref('cycling_activity_power_metrics') }} AS power
        ON power.user_id = bounds.user_id AND power.activity_id = bounds.activity_id
    LEFT JOIN {{ source('postgres_fitness', 'user_profile_current') }} AS profile
        ON profile.id = bounds.user_id
    LEFT JOIN resting_source_state AS resting ON resting.user_id = bounds.user_id
    WHERE previous.activity_id IS NULL OR previous.is_deleted = 1
        OR greatest(bounds.refreshed_at,
            coalesce(power.refreshed_at, toDateTime64('1970-01-01 00:00:00', 9)),
            coalesce(profile.updated_at, toDateTime64('1970-01-01 00:00:00', 9)),
            coalesce(resting.refreshed_at, toDateTime64('1970-01-01 00:00:00', 9))) > previous.refreshed_at
    {% endif %}
),

activity_keys AS (
    SELECT
activity_id,
user_id,
max(started_at) AS started_at,
max(ended_at) AS ended_at
    FROM (
    SELECT
activity_id,
user_id,
started_at,
ended_at
FROM activity_bounds
    {% if is_incremental() %}
    UNION DISTINCT
    SELECT previous.activity_id, previous.user_id, previous.started_at, previous.ended_at
    FROM {{ this }} AS previous FINAL
    LEFT JOIN activity_source_bounds AS bounds
        ON bounds.user_id = previous.user_id AND bounds.activity_id = previous.activity_id
    WHERE previous.is_deleted = 0 AND bounds.activity_id IS NULL
    {% endif %}
    )
    GROUP BY activity_id, user_id
),

resting_by_activity AS (
    SELECT
        bounds.activity_id AS activity_id,
        argMax(resting.resting_hr, toDate(resting.ended_at)) AS resting_hr
    FROM activity_bounds AS bounds
    INNER JOIN {{ ref('resting_heart_rate_sleep_window') }} AS resting FINAL
        ON resting.user_id = bounds.user_id
            AND toDate(resting.ended_at) <= toDate(bounds.started_at)
    WHERE resting.is_deleted = 0 AND resting.resting_hr IS NOT NULL
    GROUP BY bounds.activity_id
),

activity_metadata AS (
    SELECT
        bounds.activity_id AS activity_id,
        bounds.user_id AS user_id,
        bounds.started_at AS started_at,
        bounds.ended_at AS ended_at,
        profile.max_hr AS max_hr,
        coalesce(resting.resting_hr, profile.resting_hr) AS resting_hr,
        power.eftp AS eftp
    FROM activity_bounds AS bounds
    LEFT JOIN {{ source('postgres_fitness', 'user_profile_current') }} AS profile
        ON profile.id = bounds.user_id
    LEFT JOIN resting_by_activity AS resting ON resting.activity_id = bounds.activity_id
    LEFT JOIN {{ ref('cycling_activity_power_metrics') }} AS power
        ON power.user_id = bounds.user_id AND power.activity_id = bounds.activity_id
),

sample_points AS (
    SELECT
        samples.activity_id AS activity_id,
        samples.user_id AS user_id,
        samples.channel AS channel,
        samples.recorded_at AS recorded_at,
        samples.scalar AS scalar,
        metadata.ended_at AS ended_at,
        leadInFrame(toNullable(samples.recorded_at), 1, NULL) OVER (
            PARTITION BY samples.user_id, samples.activity_id, samples.channel
            ORDER BY samples.recorded_at
            ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
        ) AS next_at
    FROM {{ ref('activity_sensor_sample') }} AS samples FINAL
    INNER JOIN activity_metadata AS metadata
        ON metadata.activity_id = samples.activity_id AND metadata.user_id = samples.user_id
    WHERE samples.is_deleted = 0 AND samples.channel IN ('heart_rate', 'power')
        AND (samples.user_id, samples.activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM activity_bounds
        )
        AND samples.recorded_at >= metadata.started_at AND samples.recorded_at < metadata.ended_at
),

sample_intervals AS (
    SELECT
*,
dateDiff('microsecond', recorded_at, next_at) / 1000000.0 AS gap_seconds
    FROM sample_points
),

sample_cadence AS (
    SELECT
        user_id,
activity_id,
channel,
        least(10.0, greatest(1.0, medianExactIf(gap_seconds, gap_seconds > 0))) AS native_interval
    FROM sample_intervals
    GROUP BY user_id, activity_id, channel
),

covered_samples AS (
    SELECT
        points.user_id AS user_id,
        points.activity_id AS activity_id,
        points.channel AS channel,
        points.scalar AS scalar,
        if(points.scalar IS NULL OR points.scalar < 0, 0.0,
            greatest(0.0, least(
                dateDiff('microsecond', points.recorded_at, points.ended_at) / 1000000.0,
                if(points.gap_seconds <= least(10.0, greatest(5.0, cadence.native_interval * 2)),
                    points.gap_seconds, cadence.native_interval)
            ))
        ) AS covered_seconds
    FROM sample_intervals AS points
    INNER JOIN sample_cadence AS cadence
        ON cadence.user_id = points.user_id AND cadence.activity_id = points.activity_id
            AND cadence.channel = points.channel
),

observed_minutes AS (
    SELECT
        metadata.activity_id AS activity_id,
        metadata.user_id AS user_id,
        any(metadata.max_hr) AS max_hr,
        any(metadata.resting_hr) AS resting_hr,
        any(metadata.eftp) AS eftp,
        sumIf(samples.covered_seconds, samples.channel = 'heart_rate' AND samples.scalar > 0) AS hr_seconds,
        sumIf(samples.covered_seconds, samples.channel = 'power') AS power_seconds,
        sumIf(samples.covered_seconds, samples.channel = 'heart_rate' AND samples.scalar > 0
            AND samples.scalar < metadata.resting_hr + (metadata.max_hr - metadata.resting_hr) * 0.8) / 60.0 AS aerobic,
        sumIf(samples.covered_seconds, samples.channel = 'heart_rate' AND samples.scalar > 0
            AND samples.scalar >= metadata.resting_hr + (metadata.max_hr - metadata.resting_hr) * 0.8) / 60.0 AS hr_high,
        sumIf(samples.covered_seconds, samples.channel = 'power'
            AND samples.scalar >= metadata.eftp * 0.9) / 60.0 AS power_high
    FROM activity_metadata AS metadata
    LEFT JOIN covered_samples AS samples
        ON samples.user_id = metadata.user_id AND samples.activity_id = metadata.activity_id
    GROUP BY metadata.activity_id, metadata.user_id
),

zone_minutes AS (
    SELECT
        activity_id,
user_id,
        max_hr IS NOT NULL AND resting_hr IS NOT NULL AND hr_seconds > 0 AS has_hr,
        eftp IS NOT NULL AND power_seconds > 0 AS has_power,
        if(has_hr, coalesce(aerobic, toFloat64(0)), CAST(NULL, 'Nullable(Float64)')) AS aerobic_minutes,
        multiIf(has_hr AND has_power, greatest(coalesce(hr_high, toFloat64(0)), coalesce(power_high, toFloat64(0))),
            has_hr, coalesce(hr_high, toFloat64(0)),
            has_power, coalesce(power_high, toFloat64(0)), CAST(NULL, 'Nullable(Float64)')) AS high_intensity_minutes
    FROM observed_minutes
)

SELECT
    requested_activities.activity_id AS activity_id,
    requested_activities.user_id AS user_id,
    coalesce(metadata.started_at, requested_activities.started_at) AS started_at,
    coalesce(metadata.ended_at, requested_activities.ended_at) AS ended_at,
    zone_data.aerobic_minutes AS aerobic_minutes,
    zone_data.high_intensity_minutes AS high_intensity_minutes,
    if(metadata.activity_id IS NULL, 1, 0) AS is_deleted,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9) AS refreshed_at
FROM activity_keys AS requested_activities
LEFT JOIN activity_metadata AS metadata
    ON metadata.user_id = requested_activities.user_id AND metadata.activity_id = requested_activities.activity_id
LEFT JOIN zone_minutes AS zone_data
    ON zone_data.user_id = requested_activities.user_id AND zone_data.activity_id = requested_activities.activity_id
