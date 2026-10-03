{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id, duration_seconds)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1,
        'enable_materialized_cte': 1
    }
) }}

WITH activity_keys AS MATERIALIZED (
    {{ activity_sensor_dirty_keys('speed', this) }}
),

activity_bounds AS MATERIALIZED (
    SELECT
        user_id,
        activity_id,
        started_at,
        ended_at
    FROM activity_keys
    WHERE source_is_deleted = 0
        AND canonical_type IN ('cycling', 'running', 'swimming', 'walking', 'hiking')
),

activity_dates AS MATERIALIZED (
    SELECT
        user_id,
        activity_id,
        started_at,
        ended_at,
        arrayJoin(arrayMap(
            offset -> toDate(started_at) + offset,
            range(toUInt32(greatest(0, dateDiff('day', toDate(started_at), toDate(ended_at)))) + 1)
        )) AS recorded_date
    FROM activity_bounds
),

speed_samples AS (
    SELECT
        user_id,
        recorded_date,
        recorded_at,
        scalar
    FROM {{ ref('deduped_sensor') }} FINAL
    PREWHERE channel = 'speed'
        AND (user_id, recorded_date) IN (
            SELECT
                user_id,
                recorded_date
            FROM activity_dates
        )
    WHERE is_deleted = 0 AND scalar > 0
),

activity_samples AS MATERIALIZED (
    -- Eligibility is temporal. A sample's nullable activity link is provenance,
    -- not a restriction on the existing pace query's activity window.
    SELECT
        activity_dates.user_id AS user_id,
        activity_dates.activity_id AS activity_id,
        speed_samples.recorded_at AS recorded_at,
        row_number() OVER (
            PARTITION BY activity_dates.user_id, activity_dates.activity_id
            ORDER BY speed_samples.recorded_at
        ) AS row_number,
        sum(speed_samples.scalar) OVER (
            PARTITION BY activity_dates.user_id, activity_dates.activity_id
            ORDER BY speed_samples.recorded_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS cumulative_sum
    FROM activity_dates
    INNER JOIN speed_samples
        ON speed_samples.user_id = activity_dates.user_id
        AND speed_samples.recorded_date = activity_dates.recorded_date
    WHERE speed_samples.recorded_at >= activity_dates.started_at
        AND speed_samples.recorded_at <= activity_dates.ended_at
),

sample_rate AS (
    SELECT
        user_id,
        activity_id,
        greatest(
            toInt32(round(
                dateDiff('second', min(recorded_at), max(recorded_at))
                / greatest(count() - 1, 1)
            )),
            1
        ) AS interval_s
    FROM activity_samples
    GROUP BY user_id, activity_id
    HAVING count() > 1
),

duration_values AS MATERIALIZED (
    SELECT toUInt32(arrayJoin([5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200])) AS duration_seconds
),

duration_windows AS (
    SELECT
        current_sample.user_id AS user_id,
        current_sample.activity_id AS activity_id,
        duration_values.duration_seconds AS duration_seconds,
        greatest(1, toInt32(round(duration_values.duration_seconds / sample_rate.interval_s))) AS window_samples,
        (
            current_sample.cumulative_sum - coalesce(previous_sample.cumulative_sum, 0)
        ) / toFloat64(window_samples) AS average_speed
    FROM duration_values
    CROSS JOIN activity_samples AS current_sample
    INNER JOIN sample_rate
        ON sample_rate.user_id = current_sample.user_id
        AND sample_rate.activity_id = current_sample.activity_id
    LEFT JOIN activity_samples AS previous_sample
        ON previous_sample.user_id = current_sample.user_id
        AND previous_sample.activity_id = current_sample.activity_id
        AND toInt64(previous_sample.row_number) = toInt64(current_sample.row_number) - toInt64(window_samples)
    WHERE toInt64(current_sample.row_number) >= toInt64(window_samples)
),

best_per_duration AS (
    SELECT
        user_id,
        activity_id,
        duration_seconds,
        max(average_speed) AS best_speed
    FROM duration_windows
    GROUP BY user_id, activity_id, duration_seconds
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9, 'UTC'))) AS refresh_version,
        now64(9, 'UTC') AS refreshed_at
)

SELECT
    activity_keys.user_id AS user_id,
    activity_keys.activity_id AS activity_id,
    duration_values.duration_seconds AS duration_seconds,
    toNullable(best_per_duration.best_speed) AS best_speed,
    activity_keys.started_at AS started_at,
    activity_keys.ended_at AS ended_at,
    activity_keys.canonical_type AS canonical_type,
    activity_keys.source_activity_version AS source_activity_version,
    activity_keys.source_sensor_version AS source_sensor_version,
    refresh_clock.refresh_version AS refresh_version,
    toUInt8(
        activity_keys.source_is_deleted = 1
        OR activity_keys.canonical_type NOT IN ('cycling', 'running', 'swimming', 'walking', 'hiking')
    ) AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM activity_keys
CROSS JOIN duration_values
LEFT JOIN best_per_duration
    ON best_per_duration.user_id = activity_keys.user_id
    AND best_per_duration.activity_id = activity_keys.activity_id
    AND best_per_duration.duration_seconds = duration_values.duration_seconds
CROSS JOIN refresh_clock
