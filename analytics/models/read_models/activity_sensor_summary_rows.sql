{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    on_schema_change='fail',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1,
        'enable_materialized_cte': 1,
        'preferred_optimize_projection_name': 'by_activity_source_refresh_version'
    }
) }}

{% set initial_lookback_days = var('initial_lookback_days', 120) %}
{% set activity_refresh_scoped = activity_refresh_scope_enabled() %}

WITH
{% if is_incremental() %}
target_state AS (
    SELECT count() = 0 AS is_empty
    FROM {{ this }}
),
{% endif %}

sample_source_versions AS MATERIALIZED (
    SELECT
        activity_id,
        user_id,
        max(refresh_version) AS source_refresh_version
    FROM {{ ref('activity_sensor_sample') }}
    GROUP BY activity_id, user_id
),

current_activity AS (
    SELECT
        id AS activity_id,
        user_id,
        started_at
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    WHERE _peerdb_is_deleted = 0
        AND provider_absent_at IS null
        AND deleted_at IS null
),

existing_summary_state AS (
    {% if is_incremental() %}
        SELECT
            activity_id,
            user_id,
            argMax(source_refresh_version, refresh_version) AS source_refresh_version,
            argMax(is_deleted, refresh_version) AS is_deleted
        FROM {{ this }}
        GROUP BY activity_id, user_id
    {% else %}
        SELECT
            CAST(null, 'Nullable(UUID)') AS activity_id,
            CAST(null, 'Nullable(UUID)') AS user_id,
            CAST(null, 'Nullable(UInt64)') AS source_refresh_version,
            CAST(null, 'Nullable(UInt8)') AS is_deleted
        WHERE 1 = 0
    {% endif %}
),

existing_summary AS (
    SELECT
        activity_id,
        user_id
    FROM existing_summary_state
    WHERE is_deleted = 0
),

{% if activity_refresh_scoped %}
repair_scope_dirty_keys AS (
    SELECT
        deduped.activity_id,
        deduped.user_id
    FROM {{ ref('deduped_activities') }} AS deduped FINAL
    WHERE deduped.is_deleted = 0
        AND deduped.user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND (
            deduped.activity_id IN {{ activity_refresh_ids() }}
            OR hasAny(deduped.member_activity_ids, {{ activity_refresh_ids() }})
        )

    UNION DISTINCT

    SELECT
        activity_id,
        user_id
    FROM existing_summary_state
    WHERE user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND activity_id IN {{ activity_refresh_ids() }}
),
{% endif %}

initial_dirty_keys AS (
    SELECT
        activity_id,
        user_id
    FROM current_activity
    WHERE
        {% if is_incremental() %}
            (SELECT is_empty FROM target_state)
            AND started_at >= now64(6, 'UTC') - INTERVAL {{ initial_lookback_days }} DAY
        {% else %}
            started_at >= now64(6, 'UTC') - INTERVAL {{ initial_lookback_days }} DAY
        {% endif %}
),

changed_sample_dirty_keys AS (
    {% if is_incremental() %}
        SELECT DISTINCT
            sample_source_versions.activity_id AS activity_id,
            sample_source_versions.user_id AS user_id
        FROM sample_source_versions
        INNER JOIN current_activity
            ON current_activity.activity_id = sample_source_versions.activity_id
            AND current_activity.user_id = sample_source_versions.user_id
        LEFT JOIN existing_summary_state
            ON existing_summary_state.activity_id = sample_source_versions.activity_id
            AND existing_summary_state.user_id = sample_source_versions.user_id
        WHERE
            NOT (SELECT is_empty FROM target_state)
            AND (
                existing_summary_state.activity_id IS null
                OR sample_source_versions.source_refresh_version
                    > existing_summary_state.source_refresh_version
            )
    {% else %}
        SELECT
            CAST(null, 'Nullable(UUID)') AS activity_id,
            CAST(null, 'Nullable(UUID)') AS user_id
        WHERE 1 = 0
    {% endif %}
),

missing_summary_dirty_keys AS (
    {% if is_incremental() %}
        SELECT DISTINCT
            sample_source_versions.activity_id AS activity_id,
            sample_source_versions.user_id AS user_id
        FROM sample_source_versions
        INNER JOIN current_activity
            ON current_activity.activity_id = sample_source_versions.activity_id
            AND current_activity.user_id = sample_source_versions.user_id
        LEFT JOIN existing_summary_state
            ON existing_summary_state.activity_id = sample_source_versions.activity_id
            AND existing_summary_state.user_id = sample_source_versions.user_id
        WHERE existing_summary_state.activity_id IS null
    {% else %}
        SELECT
            CAST(null, 'Nullable(UUID)') AS activity_id,
            CAST(null, 'Nullable(UUID)') AS user_id
        WHERE 1 = 0
    {% endif %}
),

stale_dirty_keys AS (
    SELECT
        existing_summary.activity_id AS activity_id,
        existing_summary.user_id AS user_id
    FROM existing_summary
    LEFT JOIN current_activity
        ON current_activity.activity_id = existing_summary.activity_id
    WHERE current_activity.activity_id IS null
),

restored_dirty_keys AS (
    {% if is_incremental() %}
        SELECT
            tombstoned_summary.activity_id AS activity_id,
            tombstoned_summary.user_id AS user_id
        FROM (
            SELECT
                activity_id,
                user_id
            FROM {{ this }} FINAL
            WHERE is_deleted = 1
        ) AS tombstoned_summary
        INNER JOIN current_activity
            ON current_activity.activity_id = tombstoned_summary.activity_id
            AND current_activity.user_id = tombstoned_summary.user_id
        WHERE EXISTS (
            SELECT 1
            FROM {{ this }} AS prior_summary
            WHERE prior_summary.activity_id = tombstoned_summary.activity_id
                AND prior_summary.user_id = tombstoned_summary.user_id
                AND prior_summary.is_deleted = 0
        )
    {% else %}
        SELECT
            CAST(null, 'Nullable(UUID)') AS activity_id,
            CAST(null, 'Nullable(UUID)') AS user_id
        WHERE 1 = 0
    {% endif %}
),

dirty_keys AS MATERIALIZED (
    SELECT DISTINCT
        assumeNotNull(activity_id) AS activity_id,
        assumeNotNull(user_id) AS user_id
    FROM (
        {% if activity_refresh_scoped %}
        SELECT
            activity_id,
            user_id
        FROM repair_scope_dirty_keys
        {% else %}
        SELECT
            activity_id,
            user_id
        FROM initial_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM changed_sample_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM missing_summary_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM stale_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM restored_dirty_keys
        {% endif %}
    )
    WHERE activity_id IS NOT null
        AND user_id IS NOT null
),

active_dirty_keys AS (
    SELECT
        activity_id,
        user_id
    FROM dirty_keys
),

latest_sensor_samples AS MATERIALIZED (
    SELECT *
    FROM (
        SELECT *
        FROM {{ ref('activity_sensor_sample') }}
        WHERE (user_id, activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM active_dirty_keys
        )
        ORDER BY
            user_id ASC,
            activity_id ASC,
            channel ASC,
            recorded_at ASC,
            refresh_version DESC
        LIMIT 1 BY user_id, activity_id, channel, recorded_at
    )
    WHERE is_deleted = 0
),

deduped_samples AS (
    SELECT
        activity_id,
        user_id,
        recorded_at,
        channel,
        scalar
    FROM latest_sensor_samples
    WHERE scalar IS NOT null
),

altitude_deltas AS (
    SELECT
        activity_id,
        scalar AS altitude,
        lagInFrame(scalar) OVER (
            PARTITION BY activity_id
            ORDER BY recorded_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS prev_altitude
    FROM deduped_samples
    WHERE channel = 'altitude'
),

elevation_per_activity AS (
    SELECT
        activity_id,
        CAST(
            if(
                countIf(isNotNull(prev_altitude)) = 0,
                null,
                sum(if(
                    isNotNull(prev_altitude) AND altitude - prev_altitude > 0,
                    altitude - prev_altitude,
                    0
                ))
            ),
            'Nullable(Float64)'
        ) AS elevation_gain_m,
        CAST(
            if(
                countIf(isNotNull(prev_altitude)) = 0,
                null,
                sum(if(
                    isNotNull(prev_altitude) AND altitude - prev_altitude < 0,
                    abs(altitude - prev_altitude),
                    0
                ))
            ),
            'Nullable(Float64)'
        ) AS elevation_loss_m
    FROM altitude_deltas
    GROUP BY activity_id
),

channel_aggs AS (
    SELECT
        activity_id,
        user_id,
        CAST(avgIf(scalar, channel = 'heart_rate'), 'Nullable(Float64)') AS avg_hr,
        CAST(maxIf(scalar, channel = 'heart_rate'), 'Nullable(Int16)') AS max_hr,
        CAST(minIf(scalar, channel = 'heart_rate'), 'Nullable(Int16)') AS min_hr,
        CAST(avgIf(scalar, channel = 'power' AND scalar > 0), 'Nullable(Float64)') AS avg_power,
        CAST(maxIf(scalar, channel = 'power' AND scalar > 0), 'Nullable(Int16)') AS max_power,
        CAST(avgIf(scalar, channel = 'speed'), 'Nullable(Float64)') AS avg_speed,
        CAST(maxIf(scalar, channel = 'speed'), 'Nullable(Float64)') AS max_speed,
        CAST(avgIf(scalar, channel = 'cadence' AND scalar > 0), 'Nullable(Float64)') AS avg_cadence,
        CAST(maxIf(scalar, channel = 'altitude'), 'Nullable(Float64)') AS max_altitude,
        CAST(minIf(scalar, channel = 'altitude'), 'Nullable(Float64)') AS min_altitude,
        CAST(avgIf(scalar, channel = 'left_right_balance'), 'Nullable(Float64)') AS avg_left_balance,
        CAST(
            avgIf(scalar, channel = 'left_torque_effectiveness'),
            'Nullable(Float64)'
        ) AS avg_left_torque_eff,
        CAST(
            avgIf(scalar, channel = 'right_torque_effectiveness'),
            'Nullable(Float64)'
        ) AS avg_right_torque_eff,
        CAST(
            avgIf(scalar, channel = 'left_pedal_smoothness'),
            'Nullable(Float64)'
        ) AS avg_left_pedal_smooth,
        CAST(
            avgIf(scalar, channel = 'right_pedal_smoothness'),
            'Nullable(Float64)'
        ) AS avg_right_pedal_smooth,
        CAST(avgIf(scalar, channel = 'stance_time'), 'Nullable(Float64)') AS avg_stance_time,
        CAST(
            avgIf(scalar, channel = 'vertical_oscillation'),
            'Nullable(Float64)'
        ) AS avg_vertical_osc,
        CAST(
            avgIf(scalar, channel = 'ground_contact_time'),
            'Nullable(Float64)'
        ) AS avg_ground_contact_time,
        CAST(avgIf(scalar, channel = 'stride_length'), 'Nullable(Float64)') AS avg_stride_length,
        count() AS sample_count,
        countIf(channel = 'heart_rate') AS hr_sample_count,
        countIf(channel = 'power' AND scalar > 0) AS power_sample_count,
        min(recorded_at) AS first_sample_at,
        max(recorded_at) AS last_sample_at
    FROM deduped_samples
    GROUP BY activity_id, user_id
),

power_cumulative AS MATERIALIZED (
    SELECT
        activity_id,
        recorded_at,
        row_number() OVER (
            PARTITION BY activity_id ORDER BY recorded_at
        ) AS sample_index,
        sum(coalesce(scalar, 0)) OVER (
            PARTITION BY activity_id ORDER BY recorded_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS cumulative_power
    FROM latest_sensor_samples
    WHERE channel = 'power'
),

power_sample_rate AS (
    SELECT
        activity_id,
        greatest(toInt32(round(
            dateDiff('second', min(recorded_at), max(recorded_at))
            / greatest(count() - 1, 1)
        )), 1) AS interval_seconds
    FROM power_cumulative
    GROUP BY activity_id
    HAVING count() > 1
),

best_twenty_minute_power_per_activity AS (
    SELECT
        current_power.activity_id AS activity_id,
        CAST(max(
            toFloat64(current_power.cumulative_power - prior_power.cumulative_power)
            / greatest(round(1200.0 / power_sample_rate.interval_seconds), 1)
        ), 'Nullable(Float64)') AS best_twenty_minute_power
    FROM power_cumulative AS current_power
    INNER JOIN power_sample_rate
        ON power_sample_rate.activity_id = current_power.activity_id
    INNER JOIN power_cumulative AS prior_power
        ON prior_power.activity_id = current_power.activity_id
        AND toInt64(prior_power.sample_index)
            = toInt64(current_power.sample_index)
            - toInt64(greatest(round(1200.0 / power_sample_rate.interval_seconds), 1))
    WHERE toInt64(current_power.sample_index)
        >= toInt64(greatest(round(1200.0 / power_sample_rate.interval_seconds), 1))
    GROUP BY current_power.activity_id
),

rolling_power AS (
    SELECT
        activity_id,
        avg(scalar) OVER (
            PARTITION BY activity_id
            ORDER BY toUnixTimestamp(recorded_at)
            RANGE BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS rolling_30s_power
    FROM latest_sensor_samples
    WHERE channel = 'power'
        AND scalar > 0
),

power_variability_per_activity AS (
    SELECT
        activity_id,
        CAST(pow(avg(pow(rolling_30s_power, 4)), 0.25), 'Nullable(Float64)') AS normalized_power,
        CAST(avg(rolling_30s_power), 'Nullable(Float64)') AS smoothed_avg_power
    FROM rolling_power
    GROUP BY activity_id
    HAVING count() >= 60
),

altitude_points AS (
    SELECT
        activity_id,
        scalar AS altitude,
        recorded_at,
        lagInFrame(scalar) OVER (
            PARTITION BY activity_id ORDER BY recorded_at
        ) AS prev_altitude,
        lagInFrame(recorded_at) OVER (
            PARTITION BY activity_id ORDER BY recorded_at
        ) AS prev_recorded_at
    FROM latest_sensor_samples
    WHERE channel = 'altitude'
),

grade_activities AS (
    SELECT DISTINCT
        activity_id,
        1 AS has_grade_samples
    FROM latest_sensor_samples
    WHERE channel = 'grade'
),

grade_points AS (
    SELECT
        activity_id,
        recorded_at,
        scalar AS grade
    FROM latest_sensor_samples
    WHERE channel = 'grade'
),

climbing_segments AS (
    SELECT
        altitude_points.activity_id AS activity_id,
        altitude_points.recorded_at AS recorded_at,
        altitude_points.altitude AS altitude,
        altitude_points.prev_altitude AS prev_altitude,
        altitude_points.prev_recorded_at AS prev_recorded_at,
        grade_points.grade AS grade,
        coalesce(grade_activities.has_grade_samples, 0) = 1 AS has_grade_samples,
        row_number() OVER (
            PARTITION BY altitude_points.activity_id, altitude_points.recorded_at
            ORDER BY
                if(grade_points.recorded_at IS null, 1, 0) ASC,
                abs(dateDiff('second', grade_points.recorded_at, altitude_points.recorded_at)) ASC,
                grade_points.recorded_at ASC
        ) AS grade_rank
    FROM altitude_points
    LEFT JOIN grade_activities
        ON grade_activities.activity_id = altitude_points.activity_id
    LEFT JOIN grade_points
        ON grade_points.activity_id = altitude_points.activity_id
        AND grade_points.recorded_at
            BETWEEN altitude_points.recorded_at - INTERVAL 5 SECOND
                AND altitude_points.recorded_at + INTERVAL 5 SECOND
),

climbing_per_activity AS (
    SELECT
        activity_id,
        CAST(sum(altitude - prev_altitude), 'Nullable(Float64)') AS climbing_elevation_gain_m,
        CAST(
            sum(dateDiff('second', prev_recorded_at, recorded_at)),
            'Nullable(Int32)'
        ) AS climbing_seconds
    FROM climbing_segments
    WHERE prev_altitude IS NOT null
        AND prev_recorded_at IS NOT null
        AND altitude > prev_altitude
        AND grade_rank = 1
        AND (NOT coalesce(has_grade_samples, false) OR grade > 3)
    GROUP BY activity_id
)

SELECT
    dirty_keys.activity_id AS activity_id,
    dirty_keys.user_id AS user_id,
    channel_aggs.avg_hr AS avg_hr,
    channel_aggs.max_hr AS max_hr,
    channel_aggs.min_hr AS min_hr,
    channel_aggs.avg_power AS avg_power,
    channel_aggs.max_power AS max_power,
    channel_aggs.avg_speed AS avg_speed,
    channel_aggs.max_speed AS max_speed,
    channel_aggs.avg_cadence AS avg_cadence,
    if(
        channel_aggs.max_altitude IS NOT null AND channel_aggs.min_altitude IS NOT null,
        channel_aggs.max_altitude - channel_aggs.min_altitude,
        null
    ) AS elevation_gain_legacy,
    channel_aggs.avg_left_balance AS avg_left_balance,
    channel_aggs.avg_left_torque_eff AS avg_left_torque_eff,
    channel_aggs.avg_right_torque_eff AS avg_right_torque_eff,
    channel_aggs.avg_left_pedal_smooth AS avg_left_pedal_smooth,
    channel_aggs.avg_right_pedal_smooth AS avg_right_pedal_smooth,
    elevation_per_activity.elevation_gain_m AS elevation_gain_m,
    elevation_per_activity.elevation_loss_m AS elevation_loss_m,
    channel_aggs.avg_stance_time AS avg_stance_time,
    channel_aggs.avg_vertical_osc AS avg_vertical_osc,
    channel_aggs.avg_ground_contact_time AS avg_ground_contact_time,
    channel_aggs.avg_stride_length AS avg_stride_length,
    channel_aggs.sample_count AS sample_count,
    channel_aggs.hr_sample_count AS hr_sample_count,
    channel_aggs.power_sample_count AS power_sample_count,
    channel_aggs.first_sample_at AS first_sample_at,
    channel_aggs.last_sample_at AS last_sample_at,
    best_twenty_minute_power_per_activity.best_twenty_minute_power AS best_twenty_minute_power,
    power_variability_per_activity.normalized_power AS normalized_power,
    power_variability_per_activity.smoothed_avg_power AS smoothed_avg_power,
    climbing_per_activity.climbing_elevation_gain_m AS climbing_elevation_gain_m,
    climbing_per_activity.climbing_seconds AS climbing_seconds,
    coalesce(
        sample_source_versions.source_refresh_version,
        existing_summary_state.source_refresh_version,
        toUInt64(0)
    ) AS source_refresh_version,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    if(channel_aggs.activity_id IS null, 1, 0) AS is_deleted,
    now64(9) AS refreshed_at
FROM dirty_keys
LEFT JOIN channel_aggs
    ON channel_aggs.activity_id = dirty_keys.activity_id
    AND channel_aggs.user_id = dirty_keys.user_id
LEFT JOIN elevation_per_activity
    ON elevation_per_activity.activity_id = dirty_keys.activity_id
LEFT JOIN best_twenty_minute_power_per_activity
    ON best_twenty_minute_power_per_activity.activity_id = dirty_keys.activity_id
LEFT JOIN power_variability_per_activity
    ON power_variability_per_activity.activity_id = dirty_keys.activity_id
LEFT JOIN climbing_per_activity
    ON climbing_per_activity.activity_id = dirty_keys.activity_id
LEFT JOIN sample_source_versions
    ON sample_source_versions.activity_id = dirty_keys.activity_id
    AND sample_source_versions.user_id = dirty_keys.user_id
LEFT JOIN existing_summary_state
    ON existing_summary_state.activity_id = dirty_keys.activity_id
    AND existing_summary_state.user_id = dirty_keys.user_id
