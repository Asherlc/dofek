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

WITH RECURSIVE {{ bounded_activity_graph() }},

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
),

existing_deduped_activities AS (
    {% if is_incremental() %}
        SELECT
            activity_id,
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
        FROM {{ this }} FINAL
        WHERE is_deleted = 0
    {% else %}
        SELECT
            CAST(null, 'Nullable(UUID)') AS activity_id,
            CAST(null, 'Nullable(String)') AS provider_id,
            CAST(null, 'Nullable(UUID)') AS user_id,
            CAST(null, 'Nullable(String)') AS activity_type,
            CAST(null, 'Nullable(DateTime64(6, ''UTC''))') AS started_at,
            CAST(null, 'Nullable(DateTime64(6, ''UTC''))') AS ended_at,
            CAST(null, 'Nullable(String)') AS source_name,
            CAST(null, 'Nullable(String)') AS name,
            CAST(null, 'Nullable(String)') AS notes,
            CAST(null, 'Nullable(String)') AS timezone,
            CAST(null, 'Nullable(String)') AS raw,
            CAST(null, 'Nullable(DateTime64(9, ''UTC''))') AS source_synced_at,
            CAST([], 'Array(String)') AS source_providers,
            CAST([], 'Array(Map(String, String))') AS source_external_ids,
            CAST([], 'Array(UUID)') AS member_activity_ids
        WHERE 1 = 0
    {% endif %}
),

stale_deduped_activities AS (
    SELECT existing_deduped_activities.*
    FROM existing_deduped_activities
    LEFT JOIN current_deduped_activities
        ON current_deduped_activities.activity_id = existing_deduped_activities.activity_id
        AND current_deduped_activities.user_id = existing_deduped_activities.user_id
    WHERE current_deduped_activities.activity_id IS null
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
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    0 AS is_deleted,
    now64(9) AS refreshed_at
FROM current_deduped_activities

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
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    1 AS is_deleted,
    now64(9) AS refreshed_at
FROM stale_deduped_activities
