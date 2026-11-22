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

{% set cycling_durability_dirty_key_batch_size = var('cycling_durability_dirty_key_batch_size', 32) %}
WITH eligible_ride AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        ended_at,
        refreshed_at AS summary_refreshed_at
    FROM {{ ref('activity_summary_rows') }} FINAL
    WHERE is_deleted = 0
        AND ended_at IS NOT NULL
        AND ended_at <= now()
        AND canonical_type = 'cycling'
        AND modality IN ('outdoor', 'road', 'mountain', 'gravel', 'cyclocross')
        AND power_sample_count > 1
),

-- Raw group IDs can be superseded when sources merge.
member_records AS (
    SELECT
        membership.activity_id AS activity_id,
        membership.user_id AS user_id,
        source.activity_id AS member_id,
        source.provider_id AS provider_id,
        source.external_id AS member_external_id,
        source.started_at AS member_started_at,
        source.ended_at AS member_ended_at,
        source.raw AS source_raw,
        membership.is_deleted AS membership_deleted,
        source.is_deleted AS source_deleted,
        greatest(source.refreshed_at, membership.refreshed_at) AS member_refreshed_at
    FROM {{ ref('deduped_activity_members') }} AS membership FINAL
    INNER JOIN {{ ref('activity_source_records') }} AS source FINAL
        ON source.user_id = membership.user_id
        AND source.activity_id = membership.member_activity_id
),

canonical_members AS (
    SELECT *
    FROM member_records
    WHERE membership_deleted = 0
        AND source_deleted = 0
        AND provider_id IS NOT NULL
        AND member_started_at IS NOT NULL
),

member_watermarks AS (
    SELECT
        activity_id,
        user_id,
        max(member_refreshed_at) AS member_refreshed_at
    FROM member_records
    GROUP BY activity_id, user_id
),

-- The sensor-summary watermark keeps raw samples out of dirty-key selection.
sensor_watermarks AS (
    SELECT
        activity_id,
        user_id,
        max(refreshed_at) AS sensor_refreshed_at
    FROM {{ ref('activity_sensor_summary_rows') }} FINAL
    WHERE is_deleted = 0
    GROUP BY activity_id, user_id
),

ride_source_watermark AS MATERIALIZED (
    SELECT
        er.activity_id AS activity_id,
        er.user_id AS user_id,
        greatest(
            er.summary_refreshed_at,
            coalesce(sw.sensor_refreshed_at, toDateTime64(0, 9, 'UTC')),
            coalesce(mw.member_refreshed_at, toDateTime64(0, 9, 'UTC'))
        ) AS source_refreshed_at
    FROM eligible_ride AS er
    LEFT JOIN sensor_watermarks AS sw
        ON sw.activity_id = er.activity_id
        AND sw.user_id = er.user_id
    LEFT JOIN member_watermarks AS mw
        ON mw.activity_id = er.activity_id
        AND mw.user_id = er.user_id
),

{% if is_incremental() %}
existing_ride_state AS (
    SELECT
        activity_id,
        user_id,
        max(refreshed_at) AS processed_refreshed_at
    FROM {{ this }} FINAL
    WHERE is_deleted = 0
    GROUP BY activity_id, user_id
),

source_dirty_ride_keys AS (
    SELECT
        rsw.activity_id AS activity_id,
        rsw.user_id AS user_id
    FROM ride_source_watermark AS rsw
    LEFT JOIN existing_ride_state AS ers
        ON ers.activity_id = rsw.activity_id
        AND ers.user_id = rsw.user_id
    WHERE ers.activity_id IS NULL
        OR rsw.source_refreshed_at > ers.processed_refreshed_at
),

stale_ride_keys AS (
    SELECT
        ers.activity_id AS activity_id,
        ers.user_id AS user_id
    FROM existing_ride_state AS ers
    LEFT JOIN ride_source_watermark AS rsw
        ON rsw.activity_id = ers.activity_id
        AND rsw.user_id = ers.user_id
    WHERE rsw.activity_id IS NULL
),
{% endif %}

ride_keys AS MATERIALIZED (
    SELECT
        activity_id,
        user_id
    FROM (
    {% if is_incremental() %}
        SELECT
            activity_id,
            user_id
        FROM source_dirty_ride_keys
        UNION DISTINCT
        SELECT
            activity_id,
            user_id
        FROM stale_ride_keys
    {% else %}
        SELECT
            activity_id,
            user_id
        FROM ride_source_watermark
    {% endif %}
    )
    ORDER BY
        user_id,
        activity_id
    LIMIT {{ cycling_durability_dirty_key_batch_size }}
),

bounded_rides AS MATERIALIZED (
    SELECT er.*
    FROM eligible_ride AS er
    INNER JOIN ride_keys AS rk
        ON rk.activity_id = er.activity_id
        AND rk.user_id = er.user_id
),

bounded_power_samples AS MATERIALIZED (
    SELECT
        sample.activity_id AS activity_id,
        sample.user_id AS user_id,
        sample.recorded_at AS recorded_at,
        sample.scalar AS scalar,
        sample.is_deleted AS is_deleted,
        sample.provider_id AS provider_id,
        sample.member_activity_id AS member_activity_id,
        sample.device_id AS device_id,
        sample.measurement_kind AS measurement_kind
    FROM {{ ref('activity_sensor_sample') }} AS sample FINAL
    WHERE sample.channel = 'power'
        AND (sample.user_id, sample.activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM bounded_rides
        )
),

canonical_power_samples AS (
    SELECT s.*
    FROM bounded_power_samples AS s
    INNER JOIN canonical_members AS cm
        ON cm.activity_id = s.activity_id
        AND cm.user_id = s.user_id
        AND cm.member_id = s.member_activity_id
),

stream_members AS (
    SELECT
        activity_id,
        user_id,
        argMin(member_activity_id, recorded_at) AS member_id
    FROM canonical_power_samples
    GROUP BY activity_id, user_id
),

bounded_ride_bounds AS MATERIALIZED (
    SELECT
        br.activity_id AS activity_id,
        br.user_id AS user_id,
        br.started_at AS summary_started_at,
        br.ended_at AS summary_ended_at,
        cm.member_id AS member_id,
        cm.provider_id AS member_provider_id,
        cm.member_external_id AS member_external_id,
        cm.member_started_at AS member_started_at,
        cm.member_ended_at AS member_ended_at,
        cm.source_raw AS source_raw,
        rsw.source_refreshed_at AS source_refreshed_at
    FROM bounded_rides AS br
    INNER JOIN ride_source_watermark AS rsw
        ON rsw.activity_id = br.activity_id
        AND rsw.user_id = br.user_id
    LEFT JOIN stream_members AS sm
        ON sm.activity_id = br.activity_id
        AND sm.user_id = br.user_id
    LEFT JOIN canonical_members AS cm
        ON cm.activity_id = br.activity_id
        AND cm.user_id = br.user_id
        AND cm.member_id = sm.member_id
),

ride_bounds AS MATERIALIZED (
    SELECT
        *,
        member_provider_id = 'strava'
            AND JSONType(coalesce(source_raw, ''), 'device_watts') = 'Bool' AS has_meter_flag,
        JSONExtractBool(coalesce(source_raw, ''), 'device_watts') AS meter_flag
    FROM bounded_ride_bounds
    WHERE member_id IS NOT NULL
        AND member_ended_at IS NOT NULL
        AND member_ended_at <= now()
),

-- Keep samples from other streams as coverage barriers.
sample_provenance AS MATERIALIZED (
    SELECT
        s.activity_id AS activity_id,
        s.user_id AS user_id,
        s.recorded_at AS recorded_at,
        coalesce(s.scalar, toFloat64('NaN')) AS scalar,
        s.is_deleted AS is_deleted,
        coalesce(s.provider_id, '') AS provider_id,
        coalesce(toString(s.member_activity_id), '') AS sample_member_id,
        coalesce(s.device_id, '') AS device_id,
        s.measurement_kind AS measurement_kind,
        toString(assumeNotNull(rb.member_id)) AS member_id,
        assumeNotNull(rb.member_provider_id) AS member_provider_id,
        assumeNotNull(rb.member_started_at) AS ride_started_at,
        rb.member_external_id AS member_external_id,
        multiIf(
            s.measurement_kind = 'estimated', 'estimated',
            rb.has_meter_flag AND rb.meter_flag = 0, 'estimated',
            s.measurement_kind = 'direct', 'direct',
            rb.has_meter_flag AND rb.meter_flag = 1, 'meter_flag',
            'unknown'
        ) AS provenance
    FROM bounded_power_samples AS s
    INNER JOIN ride_bounds AS rb
        ON rb.activity_id = s.activity_id
        AND rb.user_id = s.user_id
    WHERE s.recorded_at BETWEEN rb.member_started_at AND least(rb.member_ended_at, rb.summary_ended_at)
),

sample_state_pre AS (
    SELECT
        activity_id,
        user_id,
        ride_started_at,
        arraySort(
            sample -> sample.1,
            groupArray((
                recorded_at,
                scalar,
                toUInt8(
                    is_deleted = 0
                        AND isFinite(scalar)
                        AND scalar >= 0
                        AND provenance IN ('direct', 'meter_flag')
                        AND sample_member_id = member_id
                        AND provider_id = member_provider_id
                ),
                device_id
            ))
        ) AS samples
    FROM sample_provenance
    GROUP BY activity_id, user_id, ride_started_at
),

sample_arrays AS (
    SELECT
        activity_id,
        user_id,
        ride_started_at,
        arrayMap(sample -> sample.1, samples) AS recorded_times,
        arrayMap(
            recorded_at -> dateDiff('millisecond', ride_started_at, recorded_at) / 1000.0,
            recorded_times
        ) AS offsets,
        arrayMap(sample -> sample.2, samples) AS values,
        arrayMap(sample -> sample.3, samples) AS is_valid,
        arrayMap(sample -> sample.4, samples) AS devices
    FROM sample_state_pre
),

sample_state AS (
    SELECT
        activity_id,
        user_id,
        recorded_times,
        offsets,
        values,
        arrayMap(
            (start_time, end_time) -> dateDiff('millisecond', start_time, end_time) / 1000.0,
            arrayPopBack(recorded_times),
            arrayPopFront(recorded_times)
        ) AS segment_seconds,
        arraySort(segment_seconds) AS sorted_segment_seconds,
        (
            sorted_segment_seconds[intDiv(length(segment_seconds) + 1, 2)]
            + sorted_segment_seconds[intDiv(length(segment_seconds), 2) + 1]
        ) / 2.0 AS median_sample_interval_seconds,
        least(
            10.0,
            greatest(5.0, median_sample_interval_seconds * 2.0)
        ) AS max_continuous_gap_seconds,
        arrayCumSum(
            arrayConcat(
                [toFloat64(0)],
                arrayMap(
                    (power, valid, interval_seconds) -> if(valid = 1, power, toFloat64(0)) * interval_seconds,
                    arrayPopBack(values),
                    arrayPopBack(is_valid),
                    segment_seconds
                )
            )
        ) AS cumulative_joules,
        arrayCumSum(
            arrayConcat(
                [toUInt64(0)],
                arrayMap(
                    (interval_seconds, start_valid, end_valid, start_device, end_device) -> toUInt64(
                        interval_seconds > max_continuous_gap_seconds
                        OR start_valid = 0
                        OR end_valid = 0
                        OR start_device != end_device
                    ),
                    segment_seconds,
                    arrayPopBack(is_valid),
                    arrayPopFront(is_valid),
                    arrayPopBack(devices),
                    arrayPopFront(devices)
                )
            )
        ) AS cumulative_discontinuities
    FROM sample_arrays
    WHERE length(recorded_times) > 1
        AND arrayAll(interval_seconds -> interval_seconds > 0, segment_seconds)
        AND recorded_times[1] = ride_started_at
),

endpoint_rows AS (
    SELECT
        activity_id,
        user_id,
        sample_index,
        recorded_at,
        offset_seconds,
        endpoint_joules,
        endpoint_discontinuities,
        previous_power,
        previous_segment_seconds,
        median_sample_interval_seconds
    FROM sample_state
    ARRAY JOIN
        arrayEnumerate(recorded_times) AS sample_index,
        recorded_times AS recorded_at,
        offsets AS offset_seconds,
        cumulative_joules AS endpoint_joules,
        cumulative_discontinuities AS endpoint_discontinuities,
        arrayConcat([toFloat64(0)], arrayPopBack(values)) AS previous_power,
        arrayConcat([toFloat64(0)], segment_seconds) AS previous_segment_seconds
),

power_endpoints AS MATERIALIZED (
    SELECT
        *,
        max(previous_segment_seconds) OVER (
            PARTITION BY user_id, activity_id
            ORDER BY sample_index
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS prefix_largest_gap_seconds
    FROM endpoint_rows
),

duration_values AS (
    SELECT arrayJoin([10, 60, 300, 1200]) AS duration_seconds
),

duration_windows AS (
    SELECT
        se.activity_id AS activity_id,
        se.user_id AS user_id,
        duration_values.duration_seconds AS duration_seconds,
        se.offset_seconds AS start_offset_seconds,
        se.offset_seconds + duration_values.duration_seconds AS end_offset_seconds,
        (
            ee.endpoint_joules
            - ee.previous_power * greatest(
                0,
                ee.offset_seconds - se.offset_seconds - duration_values.duration_seconds
            )
            - se.endpoint_joules
        ) / duration_values.duration_seconds AS avg_power,
        se.endpoint_joules AS prior_joules,
        ee.endpoint_discontinuities AS end_discontinuities,
        ee.sample_index - se.sample_index AS observed_samples,
        se.median_sample_interval_seconds AS median_sample_interval_seconds,
        ee.prefix_largest_gap_seconds AS prefix_and_effort_largest_gap_seconds,
        em.member_id AS member_id,
        em.member_provider_id AS provider,
        em.member_external_id AS source_external_id,
        nullIf(em.device_id, '') AS device,
        em.measurement_kind AS measurement_kind,
        em.provenance AS provenance
    FROM power_endpoints AS se
    CROSS JOIN duration_values
    ASOF JOIN power_endpoints AS ee
        ON ee.activity_id = se.activity_id
        AND ee.user_id = se.user_id
        AND ee.recorded_at >= addMilliseconds(
            se.recorded_at,
            duration_values.duration_seconds * 1000
        )
    INNER JOIN sample_provenance AS em
        ON em.activity_id = se.activity_id
        AND em.user_id = se.user_id
        AND em.recorded_at = se.recorded_at
    WHERE duration_values.duration_seconds >= se.median_sample_interval_seconds
),

valid_windows AS (
    SELECT *
    FROM duration_windows
    WHERE end_discontinuities = 0
        AND observed_samples > 0
        AND avg_power >= 0
        AND isFinite(avg_power)
),

-- Retain power records in descending work order to preserve every threshold winner.
ranked_valid_windows AS (
    SELECT
        *,
        row_number() OVER (
            PARTITION BY activity_id, user_id, duration_seconds
            ORDER BY prior_joules DESC, avg_power DESC, start_offset_seconds ASC
        ) AS frontier_rank,
        max(avg_power) OVER (
            PARTITION BY activity_id, user_id, duration_seconds
            ORDER BY prior_joules DESC, avg_power DESC, start_offset_seconds ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS prior_max_power
    FROM valid_windows
),

frontier_windows AS (
    SELECT *
    FROM ranked_valid_windows
    WHERE frontier_rank = 1 OR avg_power > prior_max_power
),

all_candidates AS MATERIALIZED (
    SELECT
        activity_id,
        user_id,
        duration_seconds,
        arraySort(
            candidate -> (candidate.4, -candidate.3, candidate.1),
            groupArray(CAST((
                start_offset_seconds,
                end_offset_seconds,
                avg_power,
                prior_joules,
                member_id,
                provider,
                source_external_id,
                device,
                measurement_kind,
                provenance,
                observed_samples,
                median_sample_interval_seconds,
                prefix_and_effort_largest_gap_seconds,
                toFloat64(100)
            ), 'Tuple(
                start_offset_seconds Float64,
                end_offset_seconds Float64,
                avg_power Float64,
                prior_joules Float64,
                source_member_id String,
                provider_id String,
                source_external_id Nullable(String),
                device_id Nullable(String),
                measurement_kind String,
                power_provenance String,
                observed_samples UInt64,
                median_sample_interval_seconds Float64,
                prefix_and_effort_largest_gap_seconds Float64,
                coverage_pct Float64
            )'))
        ) AS candidates
    FROM frontier_windows
    GROUP BY activity_id, user_id, duration_seconds
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9, 'UTC') AS refreshed_at
),

checkpoint_rows AS (
    SELECT
        brb.activity_id AS activity_id,
        brb.user_id AS user_id,
        toNullable(coalesce(brb.member_started_at, brb.summary_started_at)) AS started_at,
        0 AS duration_seconds,
        [] AS candidates,
        0 AS is_deleted,
        refresh_clock.refresh_version AS refresh_version,
        toDateTime64(brb.source_refreshed_at, 9, 'UTC') AS refreshed_at
    FROM bounded_ride_bounds AS brb
    CROSS JOIN refresh_clock
),

active_rows AS (
    SELECT
        brb.activity_id AS activity_id,
        brb.user_id AS user_id,
        toNullable(coalesce(brb.member_started_at, brb.summary_started_at)) AS started_at,
        ac.duration_seconds AS duration_seconds,
        ac.candidates AS candidates,
        0 AS is_deleted,
        refresh_clock.refresh_version AS refresh_version,
        toDateTime64(brb.source_refreshed_at, 9, 'UTC') AS refreshed_at
    FROM bounded_ride_bounds AS brb
    INNER JOIN all_candidates AS ac
        ON ac.activity_id = brb.activity_id
        AND ac.user_id = brb.user_id
    CROSS JOIN refresh_clock
    WHERE length(ac.candidates) > 0
)

{% if is_incremental() %}
,

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
            FROM ride_keys
        )
),

tombstone_rows AS (
    SELECT
        rk.activity_id AS activity_id,
        rk.user_id AS user_id,
        CAST(NULL, 'Nullable(DateTime64(6, ''UTC''))') AS started_at,
        edr.duration_seconds AS duration_seconds,
        [] AS candidates,
        1 AS is_deleted,
        refresh_clock.refresh_version AS refresh_version,
        refresh_clock.refreshed_at AS refreshed_at
    FROM ride_keys AS rk
    INNER JOIN existing_duration_rows AS edr
        ON edr.activity_id = rk.activity_id
        AND edr.user_id = rk.user_id
    LEFT JOIN bounded_ride_bounds AS brb
        ON brb.activity_id = rk.activity_id
        AND brb.user_id = rk.user_id
    LEFT JOIN all_candidates AS ac
        ON ac.activity_id = edr.activity_id
        AND ac.user_id = edr.user_id
        AND ac.duration_seconds = edr.duration_seconds
    CROSS JOIN refresh_clock
    WHERE brb.activity_id IS NULL
        OR (
            edr.duration_seconds > 0
            AND (ac.duration_seconds IS NULL OR length(ac.candidates) = 0)
        )
)
{% endif %}

SELECT * FROM checkpoint_rows
UNION ALL
SELECT * FROM active_rows
{% if is_incremental() %}
UNION ALL
SELECT * FROM tombstone_rows
{% endif %}
