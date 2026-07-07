{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id, duration_seconds)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH activity_bounds AS (
    SELECT
        activity_id,
        user_id,
        activity_type,
        started_at,
        ended_at
    FROM {{ ref('activity_summary_rows') }} FINAL
    WHERE is_deleted = 0
        AND ended_at IS NOT NULL
        AND activity_type IN ('cycling', 'road_cycling', 'mountain_biking', 'gravel_cycling', 'indoor_cycling', 'virtual_cycling', 'e_bike_cycling', 'cyclocross', 'track_cycling', 'bmx', 'hand_cycling', 'running', 'swimming', 'walking', 'hiking')
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

power_samples AS (
    SELECT
        am.activity_id AS activity_id,
        am.user_id AS user_id,
        am.started_at AS started_at,
        sensor.recorded_at AS recorded_at,
        sensor.scalar AS power,
        row_number() OVER (
            PARTITION BY am.activity_id
            ORDER BY sensor.recorded_at
        ) AS row_number,
        sum(sensor.scalar) OVER (
            PARTITION BY am.activity_id
            ORDER BY sensor.recorded_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS cumulative_sum
    FROM activity_bounds am
    INNER JOIN {{ ref('activity_sensor_sample') }} AS sensor
        ON sensor.activity_id = am.activity_id
        AND sensor.user_id = am.user_id
        AND sensor.channel = 'power'
        AND sensor.scalar > 0
        AND sensor.is_deleted = 0
),

sample_rate AS (
    SELECT
        activity_id,
        greatest(
            toInt32(round(
                dateDiff('second', min(recorded_at), max(recorded_at))
                / nullIf(count() - 1, 0)
            )),
            1
        ) AS interval_s
    FROM power_samples
    GROUP BY activity_id
    HAVING count() > 1
),

duration_values AS (
    SELECT arrayJoin([5, 15, 30, 60, 120, 180, 300, 420, 600, 1200, 1800, 3600, 5400, 7200]) AS duration_seconds
),

duration_windows AS (
    SELECT
        ps.activity_id AS activity_id,
        ps.user_id AS user_id,
        ps.started_at AS started_at,
        duration_values.duration_seconds AS duration_seconds,
        greatest(1, toInt32(round(duration_values.duration_seconds / sr.interval_s))) AS window_samples,
        (
            ps.cumulative_sum - ifNull(prev_sample.cumulative_sum, 0)
        ) / toFloat64(greatest(1, toInt32(round(duration_values.duration_seconds / sr.interval_s)))) AS avg_power
    FROM duration_values
    CROSS JOIN power_samples ps
    INNER JOIN sample_rate sr
        ON sr.activity_id = ps.activity_id
    LEFT JOIN power_samples AS prev_sample
        ON prev_sample.activity_id = ps.activity_id
        AND toInt64(prev_sample.row_number) = toInt64(ps.row_number) - toInt64(greatest(1, toInt32(round(duration_values.duration_seconds / sr.interval_s))))
    WHERE toInt64(ps.row_number) >= greatest(1, toInt32(round(duration_values.duration_seconds / sr.interval_s)))
),

best_powers AS (
    SELECT
        activity_id,
        user_id,
        any(started_at) AS started_at,
        duration_seconds,
        toInt32(round(max(avg_power))) AS best_power
    FROM duration_windows
    WHERE avg_power > 0
    GROUP BY
        activity_id,
        user_id,
        duration_seconds
),

activity_dates AS (
    SELECT
        power_samples.activity_id,
        toString(toDate(toTimeZone(power_samples.started_at, 'UTC'))) AS activity_date
    FROM power_samples
    GROUP BY power_samples.activity_id, power_samples.started_at
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    activity_keys.activity_id AS activity_id,
    activity_keys.user_id AS user_id,
    best_powers.started_at AS started_at,
    ad.activity_date AS activity_date,
    best_powers.duration_seconds AS duration_seconds,
    best_powers.best_power AS best_power,
    if(best_powers.activity_id IS NULL, 1, 0) AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM activity_keys
LEFT JOIN best_powers
    ON best_powers.activity_id = activity_keys.activity_id
    AND best_powers.user_id = activity_keys.user_id
LEFT JOIN activity_dates ad
    ON ad.activity_id = activity_keys.activity_id
CROSS JOIN refresh_clock
