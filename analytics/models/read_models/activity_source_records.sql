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

WITH active_activity AS (
    SELECT *
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    WHERE _peerdb_is_deleted = 0
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
                ORDER BY length(active_device_priority.source_name_pattern) DESC
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
        active_activity.activity_type AS activity_type,
        active_activity.started_at AS started_at,
        active_activity.ended_at AS ended_at,
        active_activity.source_name AS source_name,
        active_activity.name AS name,
        active_activity.notes AS notes,
        active_activity.timezone AS timezone,
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
    {% else %}
        SELECT CAST(null, 'Nullable(UUID)') AS activity_id
        WHERE 1 = 0
    {% endif %}
),

stale_source_records AS (
    SELECT existing_source_records.activity_id
    FROM existing_source_records
    LEFT JOIN current_source_records
        ON current_source_records.activity_id = existing_source_records.activity_id
    WHERE current_source_records.activity_id IS null
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
    activity_type,
    started_at,
    ended_at,
    source_name,
    name,
    notes,
    timezone,
    raw,
    source_synced_at,
    priority,
    refresh_clock.refresh_version AS refresh_version,
    0 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM current_source_records
CROSS JOIN refresh_clock

UNION ALL

SELECT
    assumeNotNull(activity_id) AS activity_id,
    CAST(null, 'Nullable(String)') AS provider_id,
    CAST(null, 'Nullable(UUID)') AS user_id,
    CAST(null, 'Nullable(String)') AS external_id,
    CAST(null, 'Nullable(String)') AS activity_type,
    CAST(null, 'Nullable(DateTime64(6, ''UTC''))') AS started_at,
    CAST(null, 'Nullable(DateTime64(6, ''UTC''))') AS ended_at,
    CAST(null, 'Nullable(String)') AS source_name,
    CAST(null, 'Nullable(String)') AS name,
    CAST(null, 'Nullable(String)') AS notes,
    CAST(null, 'Nullable(String)') AS timezone,
    CAST(null, 'Nullable(String)') AS raw,
    CAST(null, 'Nullable(DateTime64(9, ''UTC''))') AS source_synced_at,
    CAST(null, 'Nullable(Int32)') AS priority,
    refresh_clock.refresh_version AS refresh_version,
    1 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM stale_source_records
CROSS JOIN refresh_clock
