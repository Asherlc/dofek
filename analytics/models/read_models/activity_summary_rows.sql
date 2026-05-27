{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1
    }
) }}

{% set initial_lookback_days = var('initial_lookback_days', 120) %}

WITH
{% if is_incremental() %}
target_state AS (
    SELECT
        coalesce(
            max(refreshed_at),
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
        ) AS last_refreshed_at,
        count() = 0 AS is_empty
    FROM {{ this }}
),
{% endif %}

current_activity AS (
    SELECT
        id AS activity_id,
        user_id,
        activity_type,
        name,
        started_at,
        ended_at
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    WHERE _peerdb_is_deleted = 0
),

initial_activity_dirty_keys AS (
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

changed_raw_activity AS (
    SELECT
        id AS activity_id,
        user_id,
        started_at,
        coalesce(ended_at, started_at + INTERVAL 12 HOUR) AS ended_at
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    WHERE
        {% if is_incremental() %}
            NOT (SELECT is_empty FROM target_state)
            AND _peerdb_synced_at > (SELECT last_refreshed_at FROM target_state)
        {% else %}
            1 = 0
        {% endif %}
),

changed_activity_dirty_keys AS (
    SELECT
        activity_id,
        user_id
    FROM changed_raw_activity
),

activity_source_dirty_keys AS (
    SELECT DISTINCT
        current_activity.activity_id AS activity_id,
        current_activity.user_id AS user_id
    FROM changed_raw_activity
    INNER JOIN current_activity
        ON current_activity.user_id = changed_raw_activity.user_id
        AND current_activity.started_at <= changed_raw_activity.ended_at
        AND coalesce(
            current_activity.ended_at,
            current_activity.started_at + INTERVAL 12 HOUR
        ) >= changed_raw_activity.started_at
),

sensor_summary_dirty_keys AS (
    SELECT DISTINCT
        activity_id,
        user_id
    FROM {{ ref('activity_sensor_summary_rows') }}
    WHERE
        {% if is_incremental() %}
            NOT (SELECT is_empty FROM target_state)
            AND refreshed_at > (SELECT last_refreshed_at FROM target_state)
        {% else %}
            1 = 0
        {% endif %}
),

location_summary_dirty_keys AS (
    SELECT DISTINCT
        activity_id,
        user_id
    FROM {{ ref('activity_location_summary_rows') }}
    WHERE
        {% if is_incremental() %}
            NOT (SELECT is_empty FROM target_state)
            AND refreshed_at > (SELECT last_refreshed_at FROM target_state)
        {% else %}
            1 = 0
        {% endif %}
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
        FROM changed_activity_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM sensor_summary_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM location_summary_dirty_keys
    )
),

active_dirty_keys AS (
    SELECT
        assumeNotNull(activity_id) AS activity_id,
        assumeNotNull(user_id) AS user_id
    FROM dirty_keys
    WHERE activity_id IS NOT null
        AND user_id IS NOT null
),

existing_activity_summary_for_dirty_keys AS (
    {% if is_incremental() %}
        SELECT
            activity_id,
            user_id,
            activity_type,
            name,
            started_at,
            ended_at
        FROM {{ this }}
        WHERE (user_id, activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM active_dirty_keys
        )
        ORDER BY
            user_id ASC,
            activity_id ASC,
            refresh_version DESC
        LIMIT 1 BY user_id, activity_id
    {% else %}
        SELECT
            CAST(null, 'Nullable(UUID)') AS activity_id,
            CAST(null, 'Nullable(UUID)') AS user_id,
            CAST(null, 'Nullable(String)') AS activity_type,
            CAST(null, 'Nullable(String)') AS name,
            CAST(null, 'Nullable(DateTime64(6, ''UTC''))') AS started_at,
            CAST(null, 'Nullable(DateTime64(6, ''UTC''))') AS ended_at
        WHERE 1 = 0
    {% endif %}
),

activity_bounds AS (
    SELECT
        current_activity.activity_id AS activity_id,
        current_activity.user_id AS user_id,
        current_activity.activity_type AS activity_type,
        current_activity.name AS name,
        current_activity.started_at AS started_at,
        current_activity.ended_at AS ended_at
    FROM current_activity
    INNER JOIN dirty_keys
        ON dirty_keys.activity_id = current_activity.activity_id
        AND dirty_keys.user_id = current_activity.user_id
),

sensor_summary AS (
    SELECT *
    FROM (
        SELECT *
        FROM {{ ref('activity_sensor_summary_rows') }}
        WHERE (user_id, activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM active_dirty_keys
        )
        ORDER BY
            user_id ASC,
            activity_id ASC,
            refresh_version DESC
        LIMIT 1 BY user_id, activity_id
    )
    WHERE is_deleted = 0
),

location_summary AS (
    SELECT *
    FROM (
        SELECT *
        FROM {{ ref('activity_location_summary_rows') }}
        WHERE (user_id, activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM active_dirty_keys
        )
        ORDER BY
            user_id ASC,
            activity_id ASC,
            refresh_version DESC
        LIMIT 1 BY user_id, activity_id
    )
    WHERE is_deleted = 0
)

SELECT
    assumeNotNull(dirty_keys.activity_id) AS activity_id,
    assumeNotNull(dirty_keys.user_id) AS user_id,
    CAST(
        coalesce(activity_bounds.activity_type, existing_activity_summary_for_dirty_keys.activity_type),
        'Nullable(String)'
    ) AS activity_type,
    CAST(
        coalesce(activity_bounds.name, existing_activity_summary_for_dirty_keys.name),
        'Nullable(String)'
    ) AS name,
    CAST(
        coalesce(activity_bounds.started_at, existing_activity_summary_for_dirty_keys.started_at),
        'Nullable(DateTime64(6, ''UTC''))'
    ) AS started_at,
    CAST(
        coalesce(activity_bounds.ended_at, existing_activity_summary_for_dirty_keys.ended_at),
        'Nullable(DateTime64(6, ''UTC''))'
    ) AS ended_at,
    sensor_summary.avg_hr AS avg_hr,
    sensor_summary.max_hr AS max_hr,
    sensor_summary.min_hr AS min_hr,
    sensor_summary.avg_power AS avg_power,
    sensor_summary.max_power AS max_power,
    if(activity_bounds.activity_type IN ('indoor_cycling', 'virtual_cycling'), null, sensor_summary.avg_speed) AS avg_speed,
    if(activity_bounds.activity_type IN ('indoor_cycling', 'virtual_cycling'), null, sensor_summary.max_speed) AS max_speed,
    sensor_summary.avg_cadence AS avg_cadence,
    sensor_summary.elevation_gain_legacy AS elevation_gain_legacy,
    if(
        activity_bounds.activity_type IN ('indoor_cycling', 'virtual_cycling'),
        CAST(0, 'Nullable(Float64)'),
        coalesce(location_summary.total_distance, CAST(0, 'Nullable(Float64)'))
    ) AS total_distance,
    location_summary.centroid_lat AS centroid_lat,
    location_summary.centroid_lng AS centroid_lng,
    sensor_summary.avg_left_balance AS avg_left_balance,
    sensor_summary.avg_left_torque_eff AS avg_left_torque_eff,
    sensor_summary.avg_right_torque_eff AS avg_right_torque_eff,
    sensor_summary.avg_left_pedal_smooth AS avg_left_pedal_smooth,
    sensor_summary.avg_right_pedal_smooth AS avg_right_pedal_smooth,
    coalesce(sensor_summary.elevation_gain_m, CAST(0, 'Nullable(Float64)')) AS elevation_gain_m,
    coalesce(sensor_summary.elevation_loss_m, CAST(0, 'Nullable(Float64)')) AS elevation_loss_m,
    sensor_summary.avg_stance_time AS avg_stance_time,
    sensor_summary.avg_vertical_osc AS avg_vertical_osc,
    sensor_summary.avg_ground_contact_time AS avg_ground_contact_time,
    sensor_summary.avg_stride_length AS avg_stride_length,
    sensor_summary.sample_count AS sample_count,
    sensor_summary.hr_sample_count AS hr_sample_count,
    sensor_summary.power_sample_count AS power_sample_count,
    sensor_summary.first_sample_at AS first_sample_at,
    sensor_summary.last_sample_at AS last_sample_at,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    if(activity_bounds.activity_id IS null, 1, 0) AS is_deleted,
    now64(9) AS refreshed_at
FROM dirty_keys
LEFT JOIN activity_bounds
    ON activity_bounds.activity_id = dirty_keys.activity_id
    AND activity_bounds.user_id = dirty_keys.user_id
LEFT JOIN existing_activity_summary_for_dirty_keys
    ON existing_activity_summary_for_dirty_keys.activity_id = dirty_keys.activity_id
    AND existing_activity_summary_for_dirty_keys.user_id = dirty_keys.user_id
LEFT JOIN sensor_summary
    ON sensor_summary.activity_id = dirty_keys.activity_id
    AND sensor_summary.user_id = dirty_keys.user_id
LEFT JOIN location_summary
    ON location_summary.activity_id = dirty_keys.activity_id
    AND location_summary.user_id = dirty_keys.user_id
