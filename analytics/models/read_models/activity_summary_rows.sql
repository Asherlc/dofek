{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

{% set initial_lookback_days = var('initial_lookback_days', 120) %}
{% set activity_refresh_scoped = activity_refresh_scope_enabled() %}

WITH current_activity AS (
    SELECT
        activity_id,
        user_id,
        canonical_type,
        provider_type,
        modality,
        name,
        started_at,
        ended_at,
        refreshed_at
    FROM {{ ref('deduped_activities') }} FINAL
    WHERE is_deleted = 0
),

activity_members AS (
    SELECT
        activity_id,
        user_id,
        member_activity_id
    FROM {{ ref('deduped_activity_members') }} FINAL
    WHERE is_deleted = 0
),

target_state AS (
    SELECT
        coalesce(
            max(refreshed_at),
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
        ) AS last_refreshed_at,
        {% if is_incremental() %}(count() = 0){% else %}1{% endif %} AS is_empty
    FROM {% if is_incremental() %}{{ this }}{% else %}(SELECT CAST(null, 'Nullable(DateTime64(9, ''UTC''))') AS refreshed_at){% endif %}
),

initial_activity_dirty_keys AS (
    SELECT
        current_activity.activity_id,
        current_activity.user_id
    FROM current_activity
    CROSS JOIN target_state
    WHERE target_state.is_empty
        AND current_activity.started_at >= now64(6, 'UTC') - INTERVAL {{ initial_lookback_days }} DAY
),

changed_raw_activity AS (
    SELECT
        activity.id AS activity_id,
        activity.user_id,
        activity.started_at,
        coalesce(activity.ended_at, activity.started_at + INTERVAL 12 HOUR) AS ended_at
    FROM {{ source('postgres_fitness', 'activity') }} AS activity
    CROSS JOIN target_state
    WHERE NOT target_state.is_empty
        AND activity._peerdb_synced_at > target_state.last_refreshed_at
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
        sensor.activity_id,
        sensor.user_id
    FROM {{ ref('activity_sensor_summary_rows') }} AS sensor
    CROSS JOIN target_state
    WHERE NOT target_state.is_empty
        AND sensor.refreshed_at > target_state.last_refreshed_at
),

location_summary_dirty_keys AS (
    SELECT DISTINCT
        loc.activity_id,
        loc.user_id
    FROM {{ ref('activity_location_summary_rows') }} AS loc
    CROSS JOIN target_state
    WHERE NOT target_state.is_empty
        AND loc.refreshed_at > target_state.last_refreshed_at
),

dedupe_mapping_dirty_keys AS (
    SELECT DISTINCT
        current_activity.activity_id,
        current_activity.user_id
    FROM current_activity
    CROSS JOIN target_state
    WHERE NOT target_state.is_empty
        AND current_activity.refreshed_at > target_state.last_refreshed_at
),

existing_activity_keys AS (
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

{% if activity_refresh_scoped %}
repair_scope_dirty_keys AS (
    SELECT
        activity_id,
        user_id
    FROM current_activity
    WHERE user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND activity_id IN {{ activity_refresh_ids() }}

    UNION DISTINCT

    SELECT
        activity_id,
        user_id
    FROM activity_members
    WHERE user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND member_activity_id IN {{ activity_refresh_ids() }}

    UNION DISTINCT

    SELECT
        activity_id,
        user_id
    FROM existing_activity_keys
    WHERE user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND activity_id IN {{ activity_refresh_ids() }}
),
{% endif %}

stale_activity_dirty_keys AS (
    SELECT
        existing_activity_keys.activity_id AS activity_id,
        existing_activity_keys.user_id AS user_id
    FROM existing_activity_keys
    LEFT JOIN current_activity
        ON current_activity.activity_id = existing_activity_keys.activity_id
        AND current_activity.user_id = existing_activity_keys.user_id
    WHERE current_activity.activity_id IS null
),

dirty_key_candidates AS (
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
        FROM changed_raw_activity
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM sensor_summary_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM dedupe_mapping_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM location_summary_dirty_keys
    )
),

canonical_dirty_keys AS (
    SELECT DISTINCT
        coalesce(activity_members.activity_id, dirty_key_candidates.activity_id) AS activity_id,
        dirty_key_candidates.user_id AS user_id
    FROM dirty_key_candidates AS dirty_key_candidates
    LEFT JOIN activity_members
        ON activity_members.member_activity_id = dirty_key_candidates.activity_id
        AND activity_members.user_id = dirty_key_candidates.user_id
),

dirty_keys AS (
    SELECT DISTINCT
        activity_id,
        user_id
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
        FROM canonical_dirty_keys
        UNION ALL
        SELECT
            activity_id,
            user_id
        FROM stale_activity_dirty_keys
        {% endif %}
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
            canonical_type,
            provider_type,
            modality,
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
            CAST(null, 'Nullable(String)') AS canonical_type,
            CAST(null, 'Nullable(String)') AS provider_type,
            CAST(null, 'Nullable(String)') AS modality,
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
        current_activity.canonical_type AS canonical_type,
        current_activity.provider_type AS provider_type,
        current_activity.modality AS modality,
        current_activity.name AS name,
        current_activity.started_at AS started_at,
        current_activity.ended_at AS ended_at
    FROM current_activity
    INNER JOIN active_dirty_keys
        ON active_dirty_keys.activity_id = current_activity.activity_id
        AND active_dirty_keys.user_id = current_activity.user_id
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
    active_dirty_keys.activity_id AS activity_id,
    active_dirty_keys.user_id AS user_id,
    CAST(
        coalesce(activity_bounds.canonical_type, existing_activity_summary_for_dirty_keys.canonical_type),
        'Nullable(String)'
    ) AS canonical_type,
    CAST(
        coalesce(activity_bounds.provider_type, existing_activity_summary_for_dirty_keys.provider_type),
        'Nullable(String)'
    ) AS provider_type,
    CAST(
        coalesce(activity_bounds.modality, existing_activity_summary_for_dirty_keys.modality),
        'Nullable(String)'
    ) AS modality,
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
    if(activity_bounds.modality IN ('indoor', 'virtual'), null, sensor_summary.avg_speed) AS avg_speed,
    if(activity_bounds.modality IN ('indoor', 'virtual'), null, sensor_summary.max_speed) AS max_speed,
    sensor_summary.avg_cadence AS avg_cadence,
    sensor_summary.elevation_gain_legacy AS elevation_gain_legacy,
    if(
        activity_bounds.modality IN ('indoor', 'virtual'),
        CAST(0, 'Nullable(Float64)'),
        location_summary.total_distance
    ) AS total_distance,
    location_summary.centroid_lat AS centroid_lat,
    location_summary.centroid_lng AS centroid_lng,
    sensor_summary.avg_left_balance AS avg_left_balance,
    sensor_summary.avg_left_torque_eff AS avg_left_torque_eff,
    sensor_summary.avg_right_torque_eff AS avg_right_torque_eff,
    sensor_summary.avg_left_pedal_smooth AS avg_left_pedal_smooth,
    sensor_summary.avg_right_pedal_smooth AS avg_right_pedal_smooth,
    sensor_summary.elevation_gain_m AS elevation_gain_m,
    sensor_summary.elevation_loss_m AS elevation_loss_m,
    sensor_summary.avg_stance_time AS avg_stance_time,
    sensor_summary.avg_vertical_osc AS avg_vertical_osc,
    sensor_summary.avg_ground_contact_time AS avg_ground_contact_time,
    sensor_summary.avg_stride_length AS avg_stride_length,
    sensor_summary.sample_count AS sample_count,
    sensor_summary.hr_sample_count AS hr_sample_count,
    sensor_summary.power_sample_count AS power_sample_count,
    sensor_summary.first_sample_at AS first_sample_at,
    sensor_summary.last_sample_at AS last_sample_at,
    sensor_summary.best_twenty_minute_power AS best_twenty_minute_power,
    sensor_summary.normalized_power AS normalized_power,
    sensor_summary.smoothed_avg_power AS smoothed_avg_power,
    sensor_summary.climbing_elevation_gain_m AS climbing_elevation_gain_m,
    sensor_summary.climbing_seconds AS climbing_seconds,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    if(activity_bounds.activity_id IS null, 1, 0) AS is_deleted,
    now64(9) AS refreshed_at
FROM active_dirty_keys
LEFT JOIN activity_bounds
    ON activity_bounds.activity_id = active_dirty_keys.activity_id
    AND activity_bounds.user_id = active_dirty_keys.user_id
LEFT JOIN existing_activity_summary_for_dirty_keys
    ON existing_activity_summary_for_dirty_keys.activity_id = active_dirty_keys.activity_id
    AND existing_activity_summary_for_dirty_keys.user_id = active_dirty_keys.user_id
LEFT JOIN sensor_summary
    ON sensor_summary.activity_id = active_dirty_keys.activity_id
    AND sensor_summary.user_id = active_dirty_keys.user_id
LEFT JOIN location_summary
    ON location_summary.activity_id = active_dirty_keys.activity_id
    AND location_summary.user_id = active_dirty_keys.user_id
