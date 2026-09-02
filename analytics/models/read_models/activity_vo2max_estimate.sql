{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, started_at, activity_id, method)',
    query_settings={
        'query_plan_max_optimizations_to_apply': 100000,
        'max_threads': 1
    }
) }}

{% set initial_lookback_days = var('initial_lookback_days', 120) %}

WITH target_state AS (
    SELECT
        {% if is_incremental() %}
            coalesce(
                max(refreshed_at),
                toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
            ) AS last_refreshed_at,
            count() = 0 AS is_empty
        FROM {{ this }}
        {% else %}
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC') AS last_refreshed_at,
            true AS is_empty
        {% endif %}
),

current_activity AS (
    SELECT
        id AS activity_id,
        user_id,
        canonical_type,
        started_at,
        ended_at
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    WHERE _peerdb_is_deleted = 0
        AND provider_absent_at IS null
        AND deleted_at IS null
        AND canonical_type IN (
            'cycling',
            'running',
            'swimming',
            'walking',
            'hiking'
        )
),

recent_current_activity AS (
    SELECT *
    FROM current_activity
    WHERE started_at >= now64(6, 'UTC') - INTERVAL {{ initial_lookback_days }} DAY
),

existing_estimate AS (
    {% if is_incremental() %}
        SELECT
            activity_id,
            user_id,
            started_at,
            method
        FROM {{ this }} FINAL
        WHERE is_deleted = 0
    {% else %}
        SELECT
            CAST(null, 'Nullable(UUID)') AS activity_id,
            CAST(null, 'Nullable(UUID)') AS user_id,
            CAST(null, 'Nullable(DateTime64(6, ''UTC''))') AS started_at,
            CAST(null, 'Nullable(String)') AS method
        WHERE 1 = 0
    {% endif %}
),

initial_activity_dirty_keys AS (
    SELECT
        activity_id,
        user_id
    FROM recent_current_activity
    WHERE (SELECT is_empty FROM target_state)
),

changed_raw_activity AS (
    SELECT id
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    WHERE
        {% if is_incremental() %}
            NOT (SELECT is_empty FROM target_state)
            AND _peerdb_synced_at > (SELECT last_refreshed_at FROM target_state)
        {% else %}
            1 = 0
        {% endif %}
),

activity_source_dirty_keys AS (
    SELECT
        current_activity.activity_id AS activity_id,
        current_activity.user_id AS user_id
    FROM current_activity
    INNER JOIN changed_raw_activity
        ON changed_raw_activity.id = current_activity.activity_id
),

sensor_dirty_keys AS (
    SELECT DISTINCT
        activity_id,
        user_id
    FROM {{ ref('activity_sensor_sample') }}
    WHERE
        {% if is_incremental() %}
            NOT (SELECT is_empty FROM target_state)
            AND refreshed_at > (SELECT last_refreshed_at FROM target_state)
        {% else %}
            1 = 0
        {% endif %}
        AND channel IN ('power', 'speed', 'heart_rate', 'altitude')
),

body_measurement_dirty_users AS (
    SELECT DISTINCT user_id
    FROM analytics.body_measurement_sample FINAL
    WHERE
        {% if is_incremental() %}
            NOT (SELECT is_empty FROM target_state)
            AND _peerdb_synced_at > (SELECT last_refreshed_at FROM target_state)
        {% else %}
            1 = 0
        {% endif %}
        AND channel = 'body_weight'
),

body_measurement_dirty_keys AS (
    SELECT
        recent_current_activity.activity_id AS activity_id,
        recent_current_activity.user_id AS user_id
    FROM recent_current_activity
    INNER JOIN body_measurement_dirty_users
        ON body_measurement_dirty_users.user_id = recent_current_activity.user_id
),

profile_dirty_users AS (
    SELECT DISTINCT id AS user_id
    FROM {{ source('postgres_fitness', 'user_profile') }} FINAL
    WHERE
        {% if is_incremental() %}
            NOT (SELECT is_empty FROM target_state)
            AND _peerdb_synced_at > (SELECT last_refreshed_at FROM target_state)
        {% else %}
            1 = 0
        {% endif %}
),

profile_dirty_keys AS (
    SELECT
        recent_current_activity.activity_id AS activity_id,
        recent_current_activity.user_id AS user_id
    FROM recent_current_activity
    INNER JOIN profile_dirty_users
        ON profile_dirty_users.user_id = recent_current_activity.user_id
),

resting_heart_rate_dirty_users AS (
    SELECT DISTINCT user_id
    FROM {{ ref('resting_heart_rate_sleep_window') }} FINAL
    WHERE
        {% if is_incremental() %}
            NOT (SELECT is_empty FROM target_state)
            AND refreshed_at > (SELECT last_refreshed_at FROM target_state)
        {% else %}
            1 = 0
        {% endif %}
),

resting_heart_rate_dirty_keys AS (
    SELECT
        recent_current_activity.activity_id AS activity_id,
        recent_current_activity.user_id AS user_id
    FROM recent_current_activity
    INNER JOIN resting_heart_rate_dirty_users
        ON resting_heart_rate_dirty_users.user_id = recent_current_activity.user_id
),

stale_activity_dirty_keys AS (
    SELECT
        existing_estimate.activity_id AS activity_id,
        existing_estimate.user_id AS user_id
    FROM existing_estimate
    LEFT JOIN current_activity
        ON current_activity.activity_id = existing_estimate.activity_id
    WHERE current_activity.activity_id IS null
),

dirty_keys AS (
    SELECT DISTINCT
        activity_id,
        user_id
    FROM (
        SELECT
            activity_id,
            user_id
        FROM initial_activity_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM activity_source_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM sensor_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM body_measurement_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM profile_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM resting_heart_rate_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM stale_activity_dirty_keys
    )
),

activity_bounds AS (
    SELECT
        current_activity.activity_id AS activity_id,
        current_activity.user_id AS user_id,
        current_activity.canonical_type AS canonical_type,
        current_activity.started_at AS started_at,
        current_activity.ended_at AS ended_at
    FROM current_activity
    INNER JOIN dirty_keys
        ON dirty_keys.activity_id = current_activity.activity_id
        AND dirty_keys.user_id = current_activity.user_id
),

dirty_users AS (
    SELECT DISTINCT user_id
    FROM dirty_keys
),

latest_weight AS (
    SELECT
        body_measurement.user_id AS user_id,
        argMax(body_measurement.weight_kg, body_measurement.recorded_at) AS weight_kg
    FROM {{ ref('body_measurement') }} AS body_measurement FINAL
    INNER JOIN dirty_users
        ON dirty_users.user_id = body_measurement.user_id
    WHERE body_measurement.weight_kg IS NOT null
        AND body_measurement.is_deleted = 0
    GROUP BY body_measurement.user_id
),

power_samples AS (
    SELECT
        activity_bounds.activity_id AS activity_id,
        activity_bounds.user_id AS user_id,
        activity_bounds.started_at AS started_at,
        samples.recorded_at AS recorded_at,
        row_number() OVER (
            PARTITION BY activity_bounds.activity_id
            ORDER BY samples.recorded_at
        ) AS row_number,
        sum(samples.scalar) OVER (
            PARTITION BY activity_bounds.activity_id
            ORDER BY samples.recorded_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS cumulative_sum
    FROM activity_bounds
    INNER JOIN {{ ref('activity_sensor_sample') }} AS samples
        ON samples.activity_id = activity_bounds.activity_id
        AND samples.user_id = activity_bounds.user_id
    WHERE samples.channel = 'power'
        AND samples.scalar > 0
        AND samples.is_deleted = 0
),

power_sample_rate AS (
    SELECT
        activity_id,
        greatest(
            toInt32(round(
                dateDiff('second', min(recorded_at), max(recorded_at))
                / greatest(count() - 1, 1)
            )),
            1
        ) AS interval_s
    FROM power_samples
    GROUP BY activity_id
    HAVING count() >= 240
),

sample_windows AS (
    SELECT
        activity_id,
        greatest(1, toInt32(round(300 / interval_s))) AS window_samples
    FROM power_sample_rate
),

power_windows AS (
    SELECT
        power_samples.activity_id AS activity_id,
        power_samples.user_id AS user_id,
        power_samples.started_at AS started_at,
        (
            power_samples.cumulative_sum - coalesce(previous_sample.cumulative_sum, 0)
        ) / toFloat64(sample_windows.window_samples) AS five_minute_power_watts
    FROM power_samples
    INNER JOIN sample_windows
        ON sample_windows.activity_id = power_samples.activity_id
    LEFT JOIN power_samples AS previous_sample
        ON previous_sample.activity_id = power_samples.activity_id
        AND toInt64(previous_sample.row_number)
            = toInt64(power_samples.row_number)
            - toInt64(sample_windows.window_samples)
    WHERE toInt64(power_samples.row_number) >= toInt64(sample_windows.window_samples)
),

cycling_estimates AS (
    SELECT
        power_windows.activity_id AS activity_id,
        power_windows.user_id AS user_id,
        power_windows.started_at AS started_at,
        'cycling_power' AS method,
        (
            (max(power_windows.five_minute_power_watts) / any(latest_weight.weight_kg))
            * 10.8
            + 7
        ) AS vo2max
    FROM power_windows
    INNER JOIN latest_weight
        ON latest_weight.user_id = power_windows.user_id
    GROUP BY
        power_windows.activity_id,
        power_windows.user_id,
        power_windows.started_at
    HAVING max(power_windows.five_minute_power_watts) BETWEEN 50 AND 700
        AND vo2max > 0
),

acsm_segments AS (
    SELECT
        activity_bounds.activity_id AS activity_id,
        activity_bounds.user_id AS user_id,
        activity_bounds.started_at AS started_at,
        intDiv(toUInt32(dateDiff('second', activity_bounds.started_at, samples.recorded_at)), 300) AS segment_index,
        avgIf(samples.scalar * 60, samples.channel = 'speed') AS speed_meters_per_minute,
        avgIf(samples.scalar, samples.channel = 'heart_rate') AS average_heart_rate,
        (
            maxIf(samples.scalar, samples.channel = 'altitude')
            - minIf(samples.scalar, samples.channel = 'altitude')
        ) / nullIf(avgIf(samples.scalar, samples.channel = 'speed') * 300, 0) AS grade_fraction
    FROM activity_bounds
    INNER JOIN {{ ref('activity_sensor_sample') }} AS samples
        ON samples.activity_id = activity_bounds.activity_id
        AND samples.user_id = activity_bounds.user_id
    WHERE activity_bounds.canonical_type IN ('running', 'walking', 'hiking')
        AND samples.channel IN ('speed', 'heart_rate', 'altitude')
        AND samples.scalar IS NOT null
        AND samples.is_deleted = 0
    GROUP BY
        activity_bounds.activity_id,
        activity_bounds.user_id,
        activity_bounds.started_at,
        segment_index
    HAVING countIf(samples.channel = 'speed') >= 60
        AND countIf(samples.channel = 'heart_rate') >= 60
        AND countIf(samples.channel = 'altitude') >= 2
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
        AND resting.ended_at IS NOT null
        AND resting.resting_hr IS NOT null
    GROUP BY activity_bounds.activity_id
),

acsm_estimates AS (
    SELECT
        acsm_segments.activity_id AS activity_id,
        acsm_segments.user_id AS user_id,
        acsm_segments.started_at AS started_at,
        'submaximal_acsm' AS method,
        max((
            CASE
                WHEN acsm_segments.speed_meters_per_minute >= 134
                    THEN 0.2 * acsm_segments.speed_meters_per_minute
                        + 0.9
                        * acsm_segments.speed_meters_per_minute
                        * acsm_segments.grade_fraction
                        + 3.5
                ELSE 0.1 * acsm_segments.speed_meters_per_minute
                    + 1.8
                    * acsm_segments.speed_meters_per_minute
                    * acsm_segments.grade_fraction
                    + 3.5
            END
        ) / nullIf(
            (acsm_segments.average_heart_rate - resting.resting_hr)
            / (user_profile.max_hr - resting.resting_hr),
            0
        )) AS vo2max
    FROM acsm_segments
    INNER JOIN postgres_fitness.user_profile_current AS user_profile
        ON user_profile.id = acsm_segments.user_id
    LEFT JOIN resting_by_activity AS resting
        ON resting.activity_id = acsm_segments.activity_id
    WHERE user_profile.max_hr IS NOT null
        AND resting.resting_hr IS NOT null
        AND user_profile.max_hr > resting.resting_hr
        AND acsm_segments.speed_meters_per_minute BETWEEN 40 AND 450
        AND acsm_segments.grade_fraction BETWEEN -0.15 AND 0.15
        AND (
            (acsm_segments.average_heart_rate - resting.resting_hr)
            / (user_profile.max_hr - resting.resting_hr)
        ) >= 0.6
        AND (
            (acsm_segments.average_heart_rate - resting.resting_hr)
            / (user_profile.max_hr - resting.resting_hr)
        ) < 1
    GROUP BY
        acsm_segments.activity_id,
        acsm_segments.user_id,
        acsm_segments.started_at
),

active_estimates AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        method,
        vo2max
    FROM cycling_estimates
    WHERE vo2max BETWEEN 1 AND 100
    UNION ALL
    SELECT
        activity_id,
        user_id,
        started_at,
        method,
        vo2max
    FROM acsm_estimates
    WHERE vo2max BETWEEN 1 AND 100
),

stale_estimates AS (
    SELECT
        existing_estimate.activity_id AS activity_id,
        existing_estimate.user_id AS user_id,
        existing_estimate.started_at AS started_at,
        existing_estimate.method AS method
    FROM existing_estimate
    INNER JOIN dirty_keys
        ON dirty_keys.activity_id = existing_estimate.activity_id
        AND dirty_keys.user_id = existing_estimate.user_id
    LEFT JOIN active_estimates
        ON active_estimates.activity_id = existing_estimate.activity_id
        AND active_estimates.user_id = existing_estimate.user_id
        AND active_estimates.method = existing_estimate.method
    WHERE active_estimates.activity_id IS null
)

SELECT
    assumeNotNull(activity_id) AS activity_id,
    assumeNotNull(user_id) AS user_id,
    assumeNotNull(started_at) AS started_at,
    method,
    assumeNotNull(vo2max) AS vo2max,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    0 AS is_deleted,
    now64(9) AS refreshed_at
FROM active_estimates
UNION ALL
SELECT
    assumeNotNull(activity_id) AS activity_id,
    assumeNotNull(user_id) AS user_id,
    assumeNotNull(started_at) AS started_at,
    assumeNotNull(method) AS method,
    0.0 AS vo2max,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    1 AS is_deleted,
    now64(9) AS refreshed_at
FROM stale_estimates
