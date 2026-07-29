{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id, duration_seconds)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

{% set power_curve_dirty_key_batch_size = var('power_curve_dirty_key_batch_size', 32) %}

WITH current_activity AS (
    SELECT
        activity_id,
        user_id,
        canonical_type,
        started_at,
        ended_at,
        is_deleted,
        power_sample_count,
        refreshed_at
    FROM {{ ref('activity_summary_rows') }} FINAL
),

current_power_activity AS (
    SELECT
        current_activity.activity_id,
        current_activity.user_id,
        current_activity.refreshed_at AS source_refreshed_at
    FROM current_activity
    WHERE current_activity.is_deleted = 0
        AND current_activity.ended_at IS NOT NULL
        AND current_activity.power_sample_count > 1
        AND current_activity.canonical_type IN ('cycling', 'running', 'swimming', 'walking', 'hiking')
),

{% if is_incremental() %}
existing_activity_state AS (
    SELECT
        activity_id,
        user_id,
        max(refreshed_at) AS refreshed_at
    FROM {{ this }} FINAL
    WHERE is_deleted = 0
    GROUP BY
        activity_id,
        user_id
),

source_dirty_activity_keys AS (
    SELECT
        current_power_activity.activity_id,
        current_power_activity.user_id
    FROM current_power_activity
    LEFT JOIN existing_activity_state
        ON existing_activity_state.activity_id = current_power_activity.activity_id
        AND existing_activity_state.user_id = current_power_activity.user_id
    WHERE existing_activity_state.activity_id IS NULL
        OR current_power_activity.source_refreshed_at > existing_activity_state.refreshed_at
),

stale_activity_keys AS (
    SELECT
        existing_activity_state.activity_id,
        existing_activity_state.user_id
    FROM existing_activity_state
    LEFT JOIN current_power_activity
        ON current_power_activity.activity_id = existing_activity_state.activity_id
        AND current_power_activity.user_id = existing_activity_state.user_id
    WHERE current_power_activity.activity_id IS NULL
),
{% endif %}

activity_keys AS materialized (
    SELECT
        activity_id,
        user_id
    FROM (
    {% if is_incremental() %}
        SELECT
            activity_id,
            user_id
        FROM source_dirty_activity_keys
        UNION DISTINCT
        SELECT
            activity_id,
            user_id
        FROM stale_activity_keys
    {% else %}
        SELECT
            activity_id,
            user_id
        FROM current_power_activity
    {% endif %}
    )
    ORDER BY
        user_id,
        activity_id
    {% if is_incremental() %}
        LIMIT {{ power_curve_dirty_key_batch_size }}
    {% endif %}
),

activity_bounds AS (
    SELECT
        current_activity.activity_id,
        current_activity.user_id,
        current_activity.canonical_type,
        current_activity.started_at,
        current_activity.ended_at
    FROM current_activity
    INNER JOIN activity_keys
        ON activity_keys.activity_id = current_activity.activity_id
        AND activity_keys.user_id = current_activity.user_id
    WHERE current_activity.is_deleted = 0
        AND current_activity.ended_at IS NOT NULL
        AND current_activity.canonical_type IN ('cycling', 'running', 'swimming', 'walking', 'hiking')
),

{% if is_incremental() %}
existing_duration_rows AS (
    SELECT
        activity_id,
        user_id,
        duration_seconds
    FROM {{ this }} FINAL
    WHERE is_deleted = 0
        AND (user_id, activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM activity_keys
        )
),
{% endif %}

power_sample_groups AS (
    SELECT
        am.activity_id AS activity_id,
        am.user_id AS user_id,
        am.started_at AS started_at,
        arraySort(
            sample -> sample.1,
            groupArray((sensor.recorded_at, toFloat64(assumeNotNull(sensor.scalar))))
    ) AS samples
    FROM activity_bounds AS am
    INNER JOIN {{ ref('activity_sensor_sample') }} AS sensor FINAL
        ON sensor.activity_id = am.activity_id
        AND sensor.user_id = am.user_id
        AND sensor.channel = 'power'
        AND sensor.scalar > 0
        AND sensor.is_deleted = 0
    WHERE (sensor.user_id, sensor.activity_id) IN (
        SELECT
            user_id,
            activity_id
        FROM activity_bounds
    )
    GROUP BY
        am.activity_id,
        am.user_id,
        am.started_at
),

power_sample_arrays AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        arrayMap(sample -> sample.1, samples) AS recorded_times,
        arrayMap(sample -> sample.2, samples) AS powers
    FROM power_sample_groups
),

power_sample_segments AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        recorded_times,
        powers,
        arrayMap(
            sample_index -> dateDiff(
                'millisecond',
                recorded_times[sample_index],
                recorded_times[sample_index + 1]
            ) / 1000.0,
            arrayEnumerate(arrayPopBack(recorded_times))
        ) AS segment_seconds
    FROM power_sample_arrays
    WHERE length(recorded_times) > 1
),

power_sample_energy AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        recorded_times,
        segment_seconds,
        arrayCumSum(
            arrayConcat(
                [toFloat64(0)],
                arrayMap(
                    (power, segment_seconds) -> power * segment_seconds,
                    arrayPopBack(powers),
                    segment_seconds
                )
            )
        ) AS cumulative_energy,
        greatest(
            5.0,
            arrayReduce('quantileExact(0.5)', segment_seconds) * 2.0
        ) AS max_continuous_gap_seconds
    FROM power_sample_segments
),

power_sample_state AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        recorded_times,
        cumulative_energy,
        arrayCumSum(
            arrayConcat(
                [toUInt64(0)],
                arrayMap(
                    segment_seconds -> toUInt64(
                        segment_seconds > max_continuous_gap_seconds
                    ),
                    segment_seconds
                )
            )
        ) AS cumulative_discontinuities
    FROM power_sample_energy
),

power_sample_endpoints AS materialized (
    SELECT
        activity_id,
        user_id,
        started_at,
        endpoint_recorded_at AS recorded_at,
        endpoint_cumulative_energy AS cumulative_energy,
        endpoint_cumulative_discontinuities AS cumulative_discontinuities
    FROM power_sample_state
    ARRAY JOIN
        recorded_times AS endpoint_recorded_at,
        cumulative_energy AS endpoint_cumulative_energy,
        cumulative_discontinuities AS endpoint_cumulative_discontinuities
),

duration_values AS (
    SELECT duration_seconds
    FROM (
        SELECT arrayJoin([5, 15, 30, 60, 120, 180, 300, 420, 600, 1200, 1800, 3600, 5400, 7200]) AS duration_seconds
    )
),

duration_windows AS (
    SELECT
        start_sample.activity_id AS activity_id,
        start_sample.user_id AS user_id,
        start_sample.started_at AS started_at,
        duration_values.duration_seconds AS duration_seconds,
        (
            end_sample.cumulative_energy - start_sample.cumulative_energy
        ) / duration_values.duration_seconds AS avg_power,
        end_sample.cumulative_discontinuities
            - start_sample.cumulative_discontinuities AS discontinuity_count
    FROM power_sample_endpoints AS start_sample
    CROSS JOIN duration_values
    INNER JOIN power_sample_endpoints AS end_sample
        ON end_sample.activity_id = start_sample.activity_id
        AND end_sample.user_id = start_sample.user_id
        AND end_sample.recorded_at = addSeconds(
            start_sample.recorded_at,
            duration_values.duration_seconds
        )
),

best_powers AS (
    SELECT
        activity_id,
        user_id,
        any(started_at) AS started_at,
        duration_seconds,
        toInt32(round(max(avg_power))) AS best_power
    FROM duration_windows
    WHERE discontinuity_count = 0
        AND avg_power > 0
    GROUP BY
        activity_id,
        user_id,
        duration_seconds
),

activity_dates AS (
    SELECT
        activity_bounds.activity_id,
        toString(toDate(toTimeZone(activity_bounds.started_at, 'UTC'))) AS activity_date
    FROM activity_bounds
    GROUP BY activity_bounds.activity_id, activity_bounds.started_at
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
),

active_rows AS (
    SELECT
        activity_keys.activity_id AS activity_id,
        activity_keys.user_id AS user_id,
        toNullable(best_powers.started_at) AS started_at,
        toNullable(ad.activity_date) AS activity_date,
        best_powers.duration_seconds AS duration_seconds,
        toNullable(best_powers.best_power) AS best_power,
        0 AS is_deleted,
        refresh_clock.refresh_version AS refresh_version,
        refresh_clock.refreshed_at AS refreshed_at
    FROM activity_keys
    INNER JOIN best_powers
        ON best_powers.activity_id = activity_keys.activity_id
        AND best_powers.user_id = activity_keys.user_id
    LEFT JOIN activity_dates AS ad
        ON ad.activity_id = activity_keys.activity_id
    CROSS JOIN refresh_clock
)

{% if is_incremental() %}
,

tombstone_rows AS (
    SELECT
        activity_keys.activity_id AS activity_id,
        activity_keys.user_id AS user_id,
        CAST(NULL AS Nullable(DateTime64(6, 'UTC'))) AS started_at,
        CAST(NULL AS Nullable(String)) AS activity_date,
        existing_duration_rows.duration_seconds AS duration_seconds,
        CAST(NULL AS Nullable(Int32)) AS best_power,
        1 AS is_deleted,
        refresh_clock.refresh_version AS refresh_version,
        refresh_clock.refreshed_at AS refreshed_at
    FROM activity_keys
    INNER JOIN existing_duration_rows
        ON existing_duration_rows.activity_id = activity_keys.activity_id
        AND existing_duration_rows.user_id = activity_keys.user_id
    LEFT JOIN best_powers AS best_power_for_existing_duration
        ON best_power_for_existing_duration.activity_id = existing_duration_rows.activity_id
        AND best_power_for_existing_duration.user_id = existing_duration_rows.user_id
        AND best_power_for_existing_duration.duration_seconds = existing_duration_rows.duration_seconds
    CROSS JOIN refresh_clock
    WHERE best_power_for_existing_duration.activity_id IS NULL
)
{% endif %}

SELECT
    activity_id,
    user_id,
    started_at,
    activity_date,
    duration_seconds,
    best_power,
    is_deleted,
    refresh_version,
    refreshed_at
FROM active_rows
{% if is_incremental() %}
UNION ALL
SELECT
    activity_id,
    user_id,
    started_at,
    activity_date,
    duration_seconds,
    best_power,
    is_deleted,
    refresh_version,
    refreshed_at
FROM tombstone_rows
{% endif %}
