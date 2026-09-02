{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='activity_id',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

{% set activity_source_mass_tombstone_min_existing = var('activity_source_mass_tombstone_min_existing', 10) %}
{% set activity_source_mass_tombstone_ratio = var('activity_source_mass_tombstone_ratio', 0.95) %}
{% set activity_refresh_scoped = activity_refresh_scope_enabled() %}

WITH active_activity AS (
    SELECT *
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    WHERE
        _peerdb_is_deleted = 0
        AND provider_absent_at IS NULL
        AND deleted_at IS NULL
        {% if activity_refresh_scoped %}
        AND user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND id IN {{ activity_refresh_ids() }}
        {% endif %}
),

active_provider_priority AS (
    SELECT *
    FROM {{ source('postgres_fitness', 'provider_priority') }} FINAL
    WHERE _peerdb_is_deleted = 0
),

active_device_priority AS (
    SELECT *
    FROM {{ source('postgres_fitness', 'device_priority') }} FINAL
    WHERE _peerdb_is_deleted = 0
),

device_priority_match AS (
    SELECT
        activity_id,
        priority
    FROM (
        SELECT
            active_activity.id AS activity_id,
            active_device_priority.priority AS priority,
            row_number() OVER (
                PARTITION BY active_activity.id
                ORDER BY
                    length(active_device_priority.source_name_pattern) DESC,
                    active_device_priority.priority ASC,
                    active_device_priority.source_name_pattern ASC
            ) AS row_number
        FROM active_activity
        INNER JOIN active_device_priority
            ON active_device_priority.provider_id = active_activity.provider_id
            AND active_activity.source_name LIKE active_device_priority.source_name_pattern
    )
    WHERE row_number = 1
),

current_source_records AS (
    SELECT
        active_activity.id AS activity_id,
        active_activity.provider_id AS provider_id,
        active_activity.user_id AS user_id,
        active_activity.external_id AS external_id,
        active_activity.canonical_type AS canonical_type,
        active_activity.provider_type AS provider_type,
        active_activity.modality AS modality,
        active_activity.started_at AS started_at,
        active_activity.ended_at AS ended_at,
        active_activity.source_name AS source_name,
        active_activity.name AS name,
        active_activity.notes AS notes,
        active_activity.timezone AS timezone,
        active_activity.start_utc_offset_minutes AS start_utc_offset_minutes,
        active_activity.end_utc_offset_minutes AS end_utc_offset_minutes,
        active_activity.local_time_source AS local_time_source,
        active_activity.raw AS raw,
        active_activity._peerdb_synced_at AS source_synced_at,
        coalesce(device_priority_match.priority, active_provider_priority.priority, 100) AS priority
    FROM active_activity
    LEFT JOIN active_provider_priority
        ON active_provider_priority.provider_id = active_activity.provider_id
    LEFT JOIN device_priority_match
        ON device_priority_match.activity_id = active_activity.id
),

existing_source_records AS (
    {% if is_incremental() %}
        SELECT activity_id
        FROM {{ this }} FINAL
        WHERE is_deleted = 0
            {% if activity_refresh_scoped %}
            AND user_id = toUUID('{{ var("activity_refresh_user_id") }}')
            AND activity_id IN {{ activity_refresh_ids() }}
            {% endif %}
    {% else %}
        SELECT CAST(NULL, 'Nullable(UUID)') AS activity_id
        WHERE 1 = 0
    {% endif %}
),

stale_source_records AS (
    SELECT existing_source_records.activity_id
    FROM existing_source_records
    LEFT JOIN current_source_records
        ON current_source_records.activity_id = existing_source_records.activity_id
    WHERE current_source_records.activity_id IS NULL
),

source_record_counts AS (
    SELECT
        (SELECT count() FROM current_source_records) AS current_source_record_count,
        (SELECT count() FROM existing_source_records) AS existing_source_record_count,
        (SELECT count() FROM stale_source_records) AS stale_source_record_count
),

source_safety_check AS (
    SELECT
        throwIf(
            existing_source_record_count > 0
            AND current_source_record_count = 0,
            'Activity source mirror returned zero current rows while active activity_source_records rows already exist'
        ) AS empty_source_guard,
        throwIf(
            existing_source_record_count >= {{ activity_source_mass_tombstone_min_existing }}
            AND stale_source_record_count >= existing_source_record_count * {{ activity_source_mass_tombstone_ratio }},
            'Activity source mirror would tombstone at least {{ (activity_source_mass_tombstone_ratio * 100) | int }}% of active activity_source_records rows'
        ) AS mass_tombstone_guard
    FROM source_record_counts
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    activity_id,
    provider_id,
    user_id,
    external_id,
    canonical_type,
    provider_type,
    modality,
    started_at,
    ended_at,
    source_name,
    name,
    notes,
    timezone,
    start_utc_offset_minutes,
    end_utc_offset_minutes,
    local_time_source,
    raw,
    source_synced_at,
    priority,
    refresh_clock.refresh_version AS refresh_version,
    0 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM current_source_records
CROSS JOIN source_safety_check
CROSS JOIN refresh_clock

UNION ALL

SELECT
    assumeNotNull(activity_id) AS activity_id,
    CAST(NULL, 'Nullable(String)') AS provider_id,
    CAST(NULL, 'Nullable(UUID)') AS user_id,
    CAST(NULL, 'Nullable(String)') AS external_id,
    CAST(NULL, 'Nullable(String)') AS canonical_type,
    CAST(NULL, 'Nullable(String)') AS provider_type,
    CAST(NULL, 'Nullable(String)') AS modality,
    CAST(NULL, 'Nullable(DateTime64(6, ''UTC''))') AS started_at,
    CAST(NULL, 'Nullable(DateTime64(6, ''UTC''))') AS ended_at,
    CAST(NULL, 'Nullable(String)') AS source_name,
    CAST(NULL, 'Nullable(String)') AS name,
    CAST(NULL, 'Nullable(String)') AS notes,
    CAST(NULL, 'Nullable(String)') AS timezone,
    CAST(NULL, 'Nullable(Int16)') AS start_utc_offset_minutes,
    CAST(NULL, 'Nullable(Int16)') AS end_utc_offset_minutes,
    CAST('unknown', 'LowCardinality(String)') AS local_time_source,
    CAST(NULL, 'Nullable(String)') AS raw,
    CAST(NULL, 'Nullable(DateTime64(9, ''UTC''))') AS source_synced_at,
    CAST(NULL, 'Nullable(Int32)') AS priority,
    refresh_clock.refresh_version AS refresh_version,
    1 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM stale_source_records
CROSS JOIN source_safety_check
CROSS JOIN refresh_clock
