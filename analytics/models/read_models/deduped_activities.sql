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

WITH RECURSIVE target_state AS (
    SELECT
        coalesce(
            max(refreshed_at),
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
        ) AS last_refreshed_at,
        {% if is_incremental() %}(count() = 0){% else %}1{% endif %} AS is_empty
    FROM {% if is_incremental() %}{{ this }}{% else %}(SELECT CAST(null, 'Nullable(DateTime64(9, ''UTC''))') AS refreshed_at){% endif %}
),

priority_changes AS (
    SELECT count() > 0 AS has_changes
    FROM (
        SELECT _peerdb_synced_at
        FROM {{ source('postgres_fitness', 'provider_priority') }} FINAL
        UNION ALL
        SELECT _peerdb_synced_at
        FROM {{ source('postgres_fitness', 'device_priority') }} FINAL
    )
    WHERE NOT (SELECT is_empty FROM target_state)
        AND _peerdb_synced_at > (SELECT last_refreshed_at FROM target_state)
),

changed_activity_windows AS (
    SELECT
        activity.id AS activity_id,
        activity.user_id AS user_id,
        activity.started_at AS started_at,
        coalesce(activity.ended_at, activity.started_at + INTERVAL 12 HOUR) AS ended_at
    FROM {{ source('postgres_fitness', 'activity') }} AS activity FINAL
    WHERE NOT (SELECT is_empty FROM target_state)
        AND activity._peerdb_synced_at > (SELECT last_refreshed_at FROM target_state)
),

changed_user_windows AS (
    SELECT
        user_id,
        min(started_at) - INTERVAL 12 HOUR AS started_at,
        max(ended_at) + INTERVAL 12 HOUR AS ended_at
    FROM changed_activity_windows
    GROUP BY user_id
),

active_activity AS (
    SELECT activity.*
    FROM {{ source('postgres_fitness', 'activity') }} AS activity FINAL
    LEFT JOIN changed_user_windows
        ON changed_user_windows.user_id = activity.user_id
        AND activity.started_at < changed_user_windows.ended_at
        AND coalesce(activity.ended_at, activity.started_at + INTERVAL 12 HOUR) >= changed_user_windows.started_at
    WHERE activity._peerdb_is_deleted = 0
        AND (
            (SELECT is_empty FROM target_state)
            OR (SELECT has_changes FROM priority_changes)
            OR changed_user_windows.user_id IS NOT null
        )
),

{{ activity_dedup_graph() }},

current_deduped_activities AS (
    SELECT
        id AS activity_id,
        provider_id,
        user_id,
        activity_type,
        started_at,
        ended_at,
        source_name,
        name,
        notes,
        timezone,
        raw,
        source_synced_at,
        source_providers,
        source_external_ids,
        member_activity_ids
    FROM merged
)

{% if is_incremental() %}
,
existing_deduped_activities AS (
    SELECT
        deduped.activity_id,
        deduped.provider_id,
        deduped.user_id,
        deduped.activity_type,
        deduped.started_at,
        deduped.ended_at,
        deduped.source_name,
        deduped.name,
        deduped.notes,
        deduped.timezone,
        deduped.raw,
        deduped.source_synced_at,
        deduped.source_providers,
        deduped.source_external_ids,
        deduped.member_activity_ids
    FROM {{ this }} AS deduped FINAL
    LEFT JOIN changed_user_windows
        ON changed_user_windows.user_id = deduped.user_id
        AND deduped.started_at < changed_user_windows.ended_at
        AND coalesce(deduped.ended_at, deduped.started_at + INTERVAL 12 HOUR) >= changed_user_windows.started_at
    WHERE deduped.is_deleted = 0
        AND (
            (SELECT has_changes FROM priority_changes)
            OR changed_user_windows.user_id IS NOT null
        )
),

stale_deduped_activities AS (
    SELECT *
    FROM existing_deduped_activities
)
{% endif %}

,
changed_user_window_count AS (
    SELECT count() AS changed_window_count
    FROM changed_user_windows
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
    FROM priority_changes
    CROSS JOIN changed_user_window_count
)

SELECT
    activity_id,
    provider_id,
    user_id,
    activity_id AS primary_activity_id,
    activity_type,
    started_at,
    ended_at,
    source_name,
    name,
    notes,
    timezone,
    raw,
    source_synced_at,
    source_providers,
    source_external_ids,
    member_activity_ids,
    refresh_clock.refresh_version AS refresh_version,
    0 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM current_deduped_activities
CROSS JOIN refresh_clock

{% if is_incremental() %}
UNION ALL

SELECT
    activity_id,
    provider_id,
    user_id,
    activity_id AS primary_activity_id,
    activity_type,
    started_at,
    ended_at,
    source_name,
    name,
    notes,
    timezone,
    raw,
    source_synced_at,
    source_providers,
    source_external_ids,
    member_activity_ids,
    refresh_clock.refresh_version - 1 AS refresh_version,
    1 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM stale_deduped_activities
CROSS JOIN refresh_clock
{% endif %}
