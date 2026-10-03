{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1,
        'enable_materialized_cte': 1
    }
) }}

WITH activity_keys AS MATERIALIZED (
    {{ activity_sensor_dirty_keys('heart_rate', this) }}
),

activity_bounds AS (
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

heart_rate_samples AS (
    SELECT
        user_id,
        recorded_date,
        recorded_at,
        toFloat64(assumeNotNull(scalar)) AS heart_rate
    FROM {{ ref('deduped_sensor') }} FINAL
    PREWHERE channel = 'heart_rate'
        AND (user_id, recorded_date) IN (
            SELECT
                user_id,
                recorded_date
            FROM activity_dates
        )
    WHERE is_deleted = 0 AND scalar IS NOT null
),

value_counts AS (
    -- Training eligibility uses the inclusive temporal window regardless of
    -- nullable source activity provenance. Zero and negative HR remain eligible.
    SELECT
        activity_dates.user_id AS user_id,
        activity_dates.activity_id AS activity_id,
        heart_rate_samples.heart_rate AS heart_rate,
        count() AS sample_count
    FROM activity_dates
    INNER JOIN heart_rate_samples
        ON heart_rate_samples.user_id = activity_dates.user_id
        AND heart_rate_samples.recorded_date = activity_dates.recorded_date
    WHERE heart_rate_samples.recorded_at >= activity_dates.started_at
        AND heart_rate_samples.recorded_at <= activity_dates.ended_at
    GROUP BY activity_dates.user_id, activity_dates.activity_id, heart_rate_samples.heart_rate
),

distributions AS (
    SELECT
        user_id,
        activity_id,
        arraySort(groupArray(tuple(heart_rate, sample_count))) AS samples
    FROM value_counts
    GROUP BY user_id, activity_id
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9, 'UTC'))) AS refresh_version,
        now64(9, 'UTC') AS refreshed_at
)

SELECT
    activity_keys.user_id AS user_id,
    activity_keys.activity_id AS activity_id,
    activity_keys.started_at AS started_at,
    activity_keys.ended_at AS ended_at,
    activity_keys.canonical_type AS canonical_type,
    CAST(coalesce(distributions.samples, []), 'Array(Tuple(heart_rate Float64, sample_count UInt64))') AS samples,
    activity_keys.source_activity_version AS source_activity_version,
    activity_keys.source_sensor_version AS source_sensor_version,
    refresh_clock.refresh_version AS refresh_version,
    toUInt8(
        activity_keys.source_is_deleted = 1
        OR activity_keys.canonical_type NOT IN ('cycling', 'running', 'swimming', 'walking', 'hiking')
    ) AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM activity_keys
LEFT JOIN distributions
    ON distributions.user_id = activity_keys.user_id
    AND distributions.activity_id = activity_keys.activity_id
CROSS JOIN refresh_clock
