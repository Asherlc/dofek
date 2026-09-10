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

activity_keys AS MATERIALIZED (
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
            groupArray((
                sensor.recorded_at,
                toFloat64(assumeNotNull(sensor.scalar)),
                sensor.provider_id,
                ifNull(sensor.device_id, ''),
                sensor.measurement_kind
            ))
    ) AS samples
    FROM activity_bounds AS am
    INNER JOIN {{ ref('activity_sensor_sample') }} AS sensor FINAL
        ON sensor.activity_id = am.activity_id
        AND sensor.user_id = am.user_id
        AND sensor.channel = 'power'
        AND sensor.scalar >= 0
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
        arrayMap(
            recorded_at -> dateDiff('millisecond', started_at, recorded_at) / 1000.0,
            recorded_times
        ) AS recorded_offsets,
        arrayMap(sample -> sample.2, samples) AS powers,
        arrayMap(sample -> sample.3, samples) AS providers,
        arrayMap(sample -> sample.4, samples) AS devices,
        arrayMap(sample -> sample.5, samples) AS measurement_kinds
    FROM power_sample_groups
),

power_sample_segments AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        recorded_times,
        recorded_offsets,
        powers,
        providers,
        devices,
        measurement_kinds,
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

power_sample_resolution AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        recorded_times,
        recorded_offsets,
        powers,
        providers,
        devices,
        measurement_kinds,
        segment_seconds,
        arraySort(segment_seconds) AS sorted_segment_seconds,
        (
            sorted_segment_seconds[intDiv(length(sorted_segment_seconds) + 1, 2)]
            + sorted_segment_seconds[intDiv(length(sorted_segment_seconds), 2) + 1]
        ) / 2.0 AS median_sample_interval_seconds
    FROM power_sample_segments
    WHERE arrayAll(interval_seconds -> interval_seconds > 0, segment_seconds)
),

power_sample_state AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        recorded_times,
        recorded_offsets,
        powers,
        providers,
        devices,
        measurement_kinds,
        segment_seconds,
        median_sample_interval_seconds,
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
            median_sample_interval_seconds * 2.0
        ) AS max_continuous_gap_seconds,
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
    FROM power_sample_resolution
),

power_sample_endpoints AS MATERIALIZED (
    SELECT
        activity_id,
        user_id,
        started_at,
        sample_index,
        sample_recorded_at AS recorded_at,
        sample_recorded_offset AS recorded_offset,
        sample_power AS power,
        previous_power,
        previous_segment_seconds,
        endpoint_cumulative_energy AS cumulative_energy,
        endpoint_cumulative_discontinuities AS cumulative_discontinuities,
        median_sample_interval_seconds,
        max_continuous_gap_seconds,
        sample_provider AS provider,
        sample_device AS device,
        sample_measurement_kind AS measurement_kind
    FROM power_sample_state
    ARRAY JOIN
        arrayEnumerate(recorded_times) AS sample_index,
        recorded_times AS sample_recorded_at,
        recorded_offsets AS sample_recorded_offset,
        powers AS sample_power,
        arrayConcat([toFloat64(0)], arrayPopBack(powers)) AS previous_power,
        arrayConcat([toFloat64(0)], segment_seconds) AS previous_segment_seconds,
        cumulative_energy AS endpoint_cumulative_energy,
        cumulative_discontinuities AS endpoint_cumulative_discontinuities,
        providers AS sample_provider,
        devices AS sample_device,
        measurement_kinds AS sample_measurement_kind
),

duration_values AS (
    SELECT duration_seconds
    FROM (
        SELECT arrayJoin([1, 5, 15, 30, 60, 120, 180, 300, 420, 600, 720, 1200, 1800, 2400, 3600, 5400, 7200]) AS duration_seconds
    )
),

duration_windows AS (
    SELECT
        start_sample.activity_id AS activity_id,
        start_sample.user_id AS user_id,
        start_sample.started_at AS started_at,
        duration_values.duration_seconds AS duration_seconds,
        start_sample.sample_index AS start_sample_index,
        end_sample.sample_index AS end_endpoint_index,
        start_sample.recorded_offset AS start_offset_seconds,
        start_sample.recorded_offset + duration_values.duration_seconds AS end_offset_seconds,
        (
            end_sample.cumulative_energy
            - end_sample.previous_power * greatest(
                0,
                end_sample.recorded_offset
                    - (start_sample.recorded_offset + duration_values.duration_seconds)
            )
            - start_sample.cumulative_energy
        ) / duration_values.duration_seconds AS avg_power,
        end_sample.cumulative_discontinuities
            - start_sample.cumulative_discontinuities AS discontinuity_count,
        end_sample.sample_index - start_sample.sample_index
            + toUInt64(end_sample.recorded_offset = end_offset_seconds) AS observed_samples,
        start_sample.median_sample_interval_seconds AS median_sample_interval_seconds
    FROM power_sample_endpoints AS start_sample
    CROSS JOIN duration_values
    ASOF INNER JOIN power_sample_endpoints AS end_sample
        ON end_sample.activity_id = start_sample.activity_id
        AND end_sample.user_id = start_sample.user_id
        AND end_sample.recorded_at >= addMilliseconds(
            start_sample.recorded_at,
            duration_values.duration_seconds * 1000
        )
    WHERE duration_values.duration_seconds >= start_sample.median_sample_interval_seconds
),

ranked_powers AS (
    SELECT
        *,
        row_number() OVER (
            PARTITION BY activity_id, user_id, duration_seconds
            ORDER BY avg_power DESC, start_offset_seconds ASC
        ) AS power_rank
    FROM duration_windows
    WHERE discontinuity_count = 0
        AND avg_power >= 0
),

winning_windows AS (
    SELECT *
    FROM ranked_powers
    WHERE power_rank = 1
),

winning_evidence AS (
    SELECT
        winning_windows.activity_id AS activity_id,
        winning_windows.user_id AS user_id,
        any(winning_windows.started_at) AS started_at,
        winning_windows.duration_seconds AS duration_seconds,
        any(winning_windows.avg_power) AS avg_power,
        any(winning_windows.start_offset_seconds) AS start_offset_seconds,
        any(winning_windows.observed_samples) AS observed_samples,
        any(winning_windows.median_sample_interval_seconds) AS median_sample_interval_seconds,
        maxIf(
            evidence_sample.previous_segment_seconds,
            evidence_sample.sample_index > winning_windows.start_sample_index
        ) AS largest_gap_seconds,
        arraySort(arrayDistinct(arrayFilter(
            provider -> provider != '',
            groupArrayIf(
                evidence_sample.provider,
                evidence_sample.sample_index
                    < winning_windows.start_sample_index + winning_windows.observed_samples
            )
        ))) AS source_providers,
        arraySort(arrayDistinct(arrayFilter(
            device -> device != '',
            groupArrayIf(
                evidence_sample.device,
                evidence_sample.sample_index
                    < winning_windows.start_sample_index + winning_windows.observed_samples
            )
        ))) AS source_devices,
        groupArrayIf(
            evidence_sample.measurement_kind,
            evidence_sample.sample_index
                < winning_windows.start_sample_index + winning_windows.observed_samples
        ) AS contributing_measurement_kinds
    FROM winning_windows
    INNER JOIN power_sample_endpoints AS evidence_sample
        ON evidence_sample.activity_id = winning_windows.activity_id
        AND evidence_sample.user_id = winning_windows.user_id
        AND evidence_sample.sample_index >= winning_windows.start_sample_index
        AND evidence_sample.sample_index <= winning_windows.end_endpoint_index
    GROUP BY
        winning_windows.activity_id,
        winning_windows.user_id,
        winning_windows.duration_seconds,
        winning_windows.start_sample_index,
        winning_windows.observed_samples
),

best_powers AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        duration_seconds,
        toInt32(round(avg_power)) AS best_power,
        start_offset_seconds,
        observed_samples,
        median_sample_interval_seconds,
        largest_gap_seconds,
        toFloat64(100) AS coverage_pct,
        multiIf(
            arrayExists(kind -> kind = 'estimated', contributing_measurement_kinds),
            'estimated',
            arrayAll(kind -> kind = 'direct', contributing_measurement_kinds),
            'direct',
            'unknown'
        ) AS power_measurement_kind,
        source_providers,
        source_devices
    FROM winning_evidence
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
        toNullable(best_powers.start_offset_seconds) AS start_offset_seconds,
        toNullable(toUInt64(best_powers.observed_samples)) AS observed_samples,
        toNullable(best_powers.median_sample_interval_seconds) AS median_sample_interval_seconds,
        toNullable(best_powers.largest_gap_seconds) AS largest_gap_seconds,
        toNullable(best_powers.coverage_pct) AS coverage_pct,
        toNullable(best_powers.power_measurement_kind) AS power_measurement_kind,
        best_powers.source_providers AS source_providers,
        best_powers.source_devices AS source_devices,
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
        CAST(NULL AS Nullable(Float64)) AS start_offset_seconds,
        CAST(NULL AS Nullable(UInt64)) AS observed_samples,
        CAST(NULL AS Nullable(Float64)) AS median_sample_interval_seconds,
        CAST(NULL AS Nullable(Float64)) AS largest_gap_seconds,
        CAST(NULL AS Nullable(Float64)) AS coverage_pct,
        CAST(NULL AS Nullable(String)) AS power_measurement_kind,
        CAST([], 'Array(String)') AS source_providers,
        CAST([], 'Array(String)') AS source_devices,
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
    start_offset_seconds,
    observed_samples,
    median_sample_interval_seconds,
    largest_gap_seconds,
    coverage_pct,
    power_measurement_kind,
    source_providers,
    source_devices,
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
    start_offset_seconds,
    observed_samples,
    median_sample_interval_seconds,
    largest_gap_seconds,
    coverage_pct,
    power_measurement_kind,
    source_providers,
    source_devices,
    is_deleted,
    refresh_version,
    refreshed_at
FROM tombstone_rows
{% endif %}
