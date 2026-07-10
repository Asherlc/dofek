{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1
    }
) }}

{% set profile_recompute_lookback_days = var('profile_recompute_lookback_days', 120) %}

WITH target_state AS (
    SELECT
        {% if is_incremental() %}
            fromUnixTimestamp64Nano(toInt64(coalesce(max(refresh_version), 0))) AS last_refreshed_at,
            count() = 0 AS is_empty
        FROM {{ this }}
        {% else %}
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC') AS last_refreshed_at,
            true AS is_empty
        {% endif %}
),

current_activity AS (
    SELECT
        activity_id,
        user_id,
        started_at
    FROM {{ ref('deduped_activities') }} FINAL
    WHERE is_deleted = 0
),

existing_zone_rows AS (
    {% if is_incremental() %}
        SELECT
            activity_id,
            user_id
        FROM {{ this }} FINAL
        WHERE is_deleted = 0
    {% else %}
        SELECT
            CAST(null, 'Nullable(UUID)') AS activity_id,
            CAST(null, 'Nullable(UUID)') AS user_id
        WHERE 1 = 0
    {% endif %}
),

recent_current_activity AS (
    SELECT
        activity_id,
        user_id,
        started_at
    FROM current_activity
    WHERE started_at >= now64(6, 'UTC') - INTERVAL {{ profile_recompute_lookback_days }} DAY
),

initial_dirty_keys AS (
    SELECT
        activity_id,
        user_id
    FROM current_activity
    WHERE (SELECT is_empty FROM target_state)
),

sample_dirty_keys AS (
    SELECT DISTINCT
        activity_id,
        user_id
    FROM {{ ref('activity_sensor_sample') }}
    WHERE NOT (SELECT is_empty FROM target_state)
        AND refreshed_at > (SELECT last_refreshed_at FROM target_state)
        AND channel = 'heart_rate'
),

profile_dirty_users AS (
    SELECT DISTINCT id AS user_id
    FROM {{ source('postgres_fitness', 'user_profile') }} FINAL
    WHERE NOT (SELECT is_empty FROM target_state)
        AND _peerdb_synced_at > (SELECT last_refreshed_at FROM target_state)
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
    WHERE NOT (SELECT is_empty FROM target_state)
        AND refreshed_at > (SELECT last_refreshed_at FROM target_state)
),

resting_heart_rate_dirty_keys AS (
    SELECT
        recent_current_activity.activity_id AS activity_id,
        recent_current_activity.user_id AS user_id
    FROM recent_current_activity
    INNER JOIN resting_heart_rate_dirty_users
        ON resting_heart_rate_dirty_users.user_id = recent_current_activity.user_id
),

stale_dirty_keys AS (
    SELECT
        existing_zone_rows.activity_id AS activity_id,
        existing_zone_rows.user_id AS user_id
    FROM existing_zone_rows
    LEFT JOIN current_activity
        ON current_activity.activity_id = existing_zone_rows.activity_id
        AND current_activity.user_id = existing_zone_rows.user_id
    WHERE current_activity.activity_id IS null
),

dirty_keys AS (
    SELECT DISTINCT
        assumeNotNull(activity_id) AS activity_id,
        assumeNotNull(user_id) AS user_id
    FROM (
        SELECT
            activity_id,
            user_id
        FROM initial_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM sample_dirty_keys
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
        FROM stale_dirty_keys
    )
    WHERE activity_id IS NOT null
        AND user_id IS NOT null
),

active_dirty_keys AS (
    SELECT
        dirty_keys.activity_id AS activity_id,
        dirty_keys.user_id AS user_id
    FROM dirty_keys
    INNER JOIN current_activity
        ON current_activity.activity_id = dirty_keys.activity_id
        AND current_activity.user_id = dirty_keys.user_id
),

activity_bounds AS (
    SELECT
        current_activity.activity_id AS activity_id,
        current_activity.user_id AS user_id,
        current_activity.started_at AS started_at
    FROM current_activity
    INNER JOIN active_dirty_keys
        ON active_dirty_keys.activity_id = current_activity.activity_id
        AND active_dirty_keys.user_id = current_activity.user_id
),

resting_candidates AS (
    SELECT
        activity_bounds.activity_id AS activity_id,
        activity_bounds.user_id AS user_id,
        resting.resting_hr AS resting_hr,
        row_number() OVER (
            PARTITION BY activity_bounds.user_id, activity_bounds.activity_id
            ORDER BY resting.ended_at DESC
        ) AS recency_rank
    FROM activity_bounds
    INNER JOIN {{ ref('resting_heart_rate_sleep_window') }} AS resting FINAL
        ON resting.user_id = activity_bounds.user_id
        AND resting.ended_at <= activity_bounds.started_at
    WHERE resting.is_deleted = 0
        AND resting.ended_at IS NOT null
        AND resting.resting_hr IS NOT null
        AND resting.resting_hr > 0
),

recent_resting_values AS (
    SELECT
        activity_id,
        user_id,
        arraySort(groupArray(toFloat64(resting_hr))) AS resting_values
    FROM resting_candidates
    WHERE recency_rank <= 14
    GROUP BY activity_id, user_id
),

resting_by_activity AS (
    SELECT
        activity_id,
        user_id,
        if(
            length(resting_values) = 0,
            CAST(null, 'Nullable(Float64)'),
            if(
                modulo(length(resting_values), 2) = 1,
                CAST(resting_values[intDiv(length(resting_values), 2) + 1], 'Nullable(Float64)'),
                CAST(
                    (
                        resting_values[intDiv(length(resting_values), 2)]
                        + resting_values[intDiv(length(resting_values), 2) + 1]
                    ) / 2,
                    'Nullable(Float64)'
                )
            )
        ) AS resting_hr
    FROM recent_resting_values
),

activity_metadata AS (
    SELECT
        activity_bounds.activity_id AS activity_id,
        activity_bounds.user_id AS user_id,
        user_profile.max_hr AS max_hr,
        CASE
            WHEN resting_by_activity.resting_hr > 0
                AND resting_by_activity.resting_hr < user_profile.max_hr
                THEN resting_by_activity.resting_hr
            WHEN user_profile.resting_hr > 0
                AND user_profile.resting_hr < user_profile.max_hr
                THEN user_profile.resting_hr
            ELSE least(60, user_profile.max_hr - 1)
        END AS resting_hr
    FROM activity_bounds
    INNER JOIN postgres_fitness.user_profile_current AS user_profile
        ON user_profile.id = activity_bounds.user_id
    LEFT JOIN resting_by_activity
        ON resting_by_activity.activity_id = activity_bounds.activity_id
        AND resting_by_activity.user_id = activity_bounds.user_id
    WHERE user_profile.max_hr > 1
),

latest_sensor_samples AS (
    SELECT *
    FROM (
        SELECT *
        FROM {{ ref('activity_sensor_sample') }}
        WHERE channel = 'heart_rate'
            AND (user_id, activity_id) IN (
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

heart_rate_samples AS (
    SELECT
        activity_id,
        user_id,
        scalar AS heart_rate
    FROM latest_sensor_samples
    WHERE channel = 'heart_rate'
        AND scalar IS NOT null
),

zone_numbers AS (
    SELECT number AS zone
    FROM numbers(6)
),

zone_seconds AS (
    SELECT
        activity_metadata.user_id AS user_id,
        activity_metadata.activity_id AS activity_id,
        zone_numbers.zone AS zone,
        countIf(
            CASE
                WHEN zone_numbers.zone = 0
                    THEN heart_rate_samples.heart_rate
                        < activity_metadata.resting_hr
                        + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.5
                WHEN zone_numbers.zone = 1
                    THEN heart_rate_samples.heart_rate
                        >= activity_metadata.resting_hr
                        + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.5
                        AND heart_rate_samples.heart_rate
                        < activity_metadata.resting_hr
                        + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.6
                WHEN zone_numbers.zone = 2
                    THEN heart_rate_samples.heart_rate
                        >= activity_metadata.resting_hr
                        + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.6
                        AND heart_rate_samples.heart_rate
                        < activity_metadata.resting_hr
                        + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.7
                WHEN zone_numbers.zone = 3
                    THEN heart_rate_samples.heart_rate
                        >= activity_metadata.resting_hr
                        + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.7
                        AND heart_rate_samples.heart_rate
                        < activity_metadata.resting_hr
                        + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.8
                WHEN zone_numbers.zone = 4
                    THEN heart_rate_samples.heart_rate
                        >= activity_metadata.resting_hr
                        + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.8
                        AND heart_rate_samples.heart_rate
                        < activity_metadata.resting_hr
                        + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.9
                WHEN zone_numbers.zone = 5
                    THEN heart_rate_samples.heart_rate
                        >= activity_metadata.resting_hr
                        + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.9
                ELSE false
            END
        ) AS seconds
    FROM activity_metadata
    CROSS JOIN zone_numbers
    LEFT JOIN heart_rate_samples
        ON heart_rate_samples.activity_id = activity_metadata.activity_id
        AND heart_rate_samples.user_id = activity_metadata.user_id
    GROUP BY activity_metadata.user_id, activity_metadata.activity_id, zone_numbers.zone
),

zones_by_activity AS (
    SELECT
        user_id,
        activity_id,
        arraySort(
            zone -> zone.1,
            groupArray(tuple(toUInt8(zone), toUInt32(seconds)))
        ) AS zones
    FROM zone_seconds
    GROUP BY user_id, activity_id
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    dirty_keys.user_id AS user_id,
    dirty_keys.activity_id AS activity_id,
    if(
        zones_by_activity.activity_id IS null,
        CAST([], 'Array(Tuple(UInt8, UInt32))'),
        zones_by_activity.zones
    ) AS zones,
    refresh_clock.refresh_version AS refresh_version,
    if(zones_by_activity.activity_id IS null, 1, 0) AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM dirty_keys
CROSS JOIN refresh_clock
LEFT JOIN zones_by_activity
    ON zones_by_activity.activity_id = dirty_keys.activity_id
    AND zones_by_activity.user_id = dirty_keys.user_id
