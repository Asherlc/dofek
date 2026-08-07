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

WITH activity_summary_state AS (
    SELECT *
    FROM {{ ref('activity_summary_rows') }} FINAL
),

activity_identity_state AS (
    SELECT *
    FROM {{ ref('deduped_activities') }} FINAL
),

efficiency_state AS (
    SELECT *
    FROM {{ ref('activity_aerobic_efficiency') }} FINAL
),

target_state AS (
    SELECT
        coalesce(max(refreshed_at), toDateTime64('1970-01-01 00:00:00', 9, 'UTC')) AS last_refreshed_at,
        {% if is_incremental() %}(count() = 0){% else %}1{% endif %} AS is_empty
    FROM {% if is_incremental() %}{{ this }}{% else %}(SELECT CAST(null, 'Nullable(DateTime64(9, ''UTC''))') AS refreshed_at){% endif %}
),

dirty_keys AS (
    SELECT
        activity_id,
        user_id
    FROM activity_summary_state
    CROSS JOIN target_state
    WHERE target_state.is_empty OR activity_summary_state.refreshed_at > target_state.last_refreshed_at
    UNION DISTINCT
    SELECT
        activity_id,
        user_id
    FROM activity_identity_state
    CROSS JOIN target_state
    WHERE target_state.is_empty OR activity_identity_state.refreshed_at > target_state.last_refreshed_at
    UNION DISTINCT
    SELECT
        activity_id,
        user_id
    FROM efficiency_state
    CROSS JOIN target_state
    WHERE target_state.is_empty OR efficiency_state.refreshed_at > target_state.last_refreshed_at
),

active_cycling AS (
    SELECT
        summary.activity_id AS activity_id,
        summary.user_id AS user_id,
        assumeNotNull(identity.provider_id) AS provider_id,
        identity.source_providers AS source_providers,
        assumeNotNull(summary.canonical_type) AS canonical_type,
        summary.provider_type AS provider_type,
        summary.modality AS modality,
        summary.name AS activity_name,
        assumeNotNull(summary.started_at) AS started_at,
        summary.ended_at AS ended_at,
        summary.total_distance AS distance_meters,
        summary.avg_hr AS average_heart_rate,
        summary.max_hr AS max_heart_rate,
        summary.avg_power AS average_power,
        coalesce(summary.power_sample_count, 0) AS power_samples,
        coalesce(summary.hr_sample_count, 0) AS heart_rate_samples,
        summary.normalized_power AS normalized_power,
        summary.best_twenty_minute_power AS best_twenty_minute_power,
        summary.elevation_gain_m AS elevation_gain_meters,
        if(
            summary.ended_at IS null,
            0,
            greatest(
                toInt32(dateDiff(
                    'second',
                    assumeNotNull(summary.started_at),
                    assumeNotNull(summary.ended_at)
                )),
                0
            )
        ) AS elapsed_seconds,
        efficiency.max_hr AS efficiency_max_heart_rate,
        efficiency.avg_power_z2 AS average_power_zone_two,
        efficiency.avg_hr_z2 AS average_heart_rate_zone_two,
        efficiency.efficiency_factor AS efficiency_factor,
        efficiency.z2_samples AS zone_two_samples
    FROM activity_summary_state AS summary
    INNER JOIN activity_identity_state AS identity
        ON identity.activity_id = summary.activity_id
        AND identity.user_id = summary.user_id
        AND identity.is_deleted = 0
    LEFT JOIN efficiency_state AS efficiency
        ON efficiency.activity_id = summary.activity_id
        AND efficiency.user_id = summary.user_id
        AND efficiency.is_deleted = 0
    WHERE summary.is_deleted = 0
        AND identity.provider_id IS NOT null
        AND summary.canonical_type IS NOT null
        AND summary.started_at IS NOT null
        AND summary.canonical_type = 'cycling'
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9, 'UTC') AS refreshed_at
),

active_rows AS (
    SELECT
        active_cycling.activity_id AS activity_id,
        active_cycling.user_id AS user_id,
        active_cycling.provider_id AS provider_id,
        active_cycling.source_providers AS source_providers,
        active_cycling.canonical_type AS canonical_type,
        active_cycling.provider_type AS provider_type,
        active_cycling.modality AS modality,
        active_cycling.activity_name AS activity_name,
        active_cycling.started_at AS started_at,
        active_cycling.ended_at AS ended_at,
        active_cycling.distance_meters AS distance_meters,
        active_cycling.average_heart_rate AS average_heart_rate,
        active_cycling.max_heart_rate AS max_heart_rate,
        active_cycling.average_power AS average_power,
        active_cycling.power_samples AS power_samples,
        active_cycling.heart_rate_samples AS heart_rate_samples,
        active_cycling.normalized_power AS normalized_power,
        active_cycling.best_twenty_minute_power AS best_twenty_minute_power,
        active_cycling.elevation_gain_meters AS elevation_gain_meters,
        active_cycling.elapsed_seconds AS elapsed_seconds,
        active_cycling.efficiency_max_heart_rate AS efficiency_max_heart_rate,
        active_cycling.average_power_zone_two AS average_power_zone_two,
        active_cycling.average_heart_rate_zone_two AS average_heart_rate_zone_two,
        active_cycling.efficiency_factor AS efficiency_factor,
        active_cycling.zone_two_samples AS zone_two_samples,
        toUInt8(0) AS is_deleted,
        refresh_clock.refresh_version AS refresh_version,
        refresh_clock.refreshed_at AS refreshed_at
    FROM active_cycling
    INNER JOIN dirty_keys
        ON dirty_keys.activity_id = active_cycling.activity_id
        AND dirty_keys.user_id = active_cycling.user_id
    CROSS JOIN refresh_clock
)

{% if is_incremental() %}
,
existing_rows AS (
    SELECT *
    FROM {{ this }} FINAL
    WHERE is_deleted = 0
),

tombstone_rows AS (
    SELECT
        existing_rows.activity_id AS activity_id,
        existing_rows.user_id AS user_id,
        existing_rows.provider_id AS provider_id,
        existing_rows.source_providers AS source_providers,
        existing_rows.canonical_type AS canonical_type,
        existing_rows.provider_type AS provider_type,
        existing_rows.modality AS modality,
        existing_rows.activity_name AS activity_name,
        existing_rows.started_at AS started_at,
        existing_rows.ended_at AS ended_at,
        existing_rows.distance_meters AS distance_meters,
        existing_rows.average_heart_rate AS average_heart_rate,
        existing_rows.max_heart_rate AS max_heart_rate,
        existing_rows.average_power AS average_power,
        existing_rows.power_samples AS power_samples,
        existing_rows.heart_rate_samples AS heart_rate_samples,
        existing_rows.normalized_power AS normalized_power,
        existing_rows.best_twenty_minute_power AS best_twenty_minute_power,
        existing_rows.elevation_gain_meters AS elevation_gain_meters,
        existing_rows.elapsed_seconds AS elapsed_seconds,
        existing_rows.efficiency_max_heart_rate AS efficiency_max_heart_rate,
        existing_rows.average_power_zone_two AS average_power_zone_two,
        existing_rows.average_heart_rate_zone_two AS average_heart_rate_zone_two,
        existing_rows.efficiency_factor AS efficiency_factor,
        existing_rows.zone_two_samples AS zone_two_samples,
        toUInt8(1) AS is_deleted,
        refresh_clock.refresh_version AS refresh_version,
        refresh_clock.refreshed_at AS refreshed_at
    FROM existing_rows
    INNER JOIN dirty_keys
        ON dirty_keys.activity_id = existing_rows.activity_id
        AND dirty_keys.user_id = existing_rows.user_id
    LEFT JOIN active_cycling
        ON active_cycling.activity_id = existing_rows.activity_id
        AND active_cycling.user_id = existing_rows.user_id
    CROSS JOIN refresh_clock
    WHERE active_cycling.activity_id IS null
)
{% endif %}

SELECT
    activity_id,
    user_id,
    provider_id,
    source_providers,
    canonical_type,
    provider_type,
    modality,
    activity_name,
    started_at,
    ended_at,
    distance_meters,
    average_heart_rate,
    max_heart_rate,
    average_power,
    power_samples,
    heart_rate_samples,
    normalized_power,
    best_twenty_minute_power,
    elevation_gain_meters,
    elapsed_seconds,
    efficiency_max_heart_rate,
    average_power_zone_two,
    average_heart_rate_zone_two,
    efficiency_factor,
    zone_two_samples,
    is_deleted,
    refresh_version,
    refreshed_at
FROM active_rows
{% if is_incremental() %}
UNION ALL
SELECT
    activity_id,
    user_id,
    provider_id,
    source_providers,
    canonical_type,
    provider_type,
    modality,
    activity_name,
    started_at,
    ended_at,
    distance_meters,
    average_heart_rate,
    max_heart_rate,
    average_power,
    power_samples,
    heart_rate_samples,
    normalized_power,
    best_twenty_minute_power,
    elevation_gain_meters,
    elapsed_seconds,
    efficiency_max_heart_rate,
    average_power_zone_two,
    average_heart_rate_zone_two,
    efficiency_factor,
    zone_two_samples,
    is_deleted,
    refresh_version,
    refreshed_at
FROM tombstone_rows
{% endif %}
