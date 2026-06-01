{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, member_activity_id)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

WITH current_activity_members AS (
    SELECT
        deduped_activities.activity_id AS activity_id,
        deduped_activities.user_id AS user_id,
        deduped_activities.started_at AS started_at,
        deduped_activities.ended_at AS ended_at,
        deduped_activities.source_synced_at AS source_synced_at,
        arrayJoin(deduped_activities.member_activity_ids) AS member_activity_id
    FROM (
        SELECT *
        FROM {{ ref('deduped_activities') }} FINAL
        WHERE is_deleted = 0
    ) AS deduped_activities
),

existing_activity_members AS (
    {% if is_incremental() %}
        SELECT
            activity_id,
            user_id,
            started_at,
            ended_at,
            source_synced_at,
            member_activity_id
        FROM {{ this }} FINAL
        WHERE is_deleted = 0
    {% else %}
        SELECT
            CAST(null, 'Nullable(UUID)') AS activity_id,
            CAST(null, 'Nullable(UUID)') AS user_id,
            CAST(null, 'Nullable(DateTime64(6, ''UTC''))') AS started_at,
            CAST(null, 'Nullable(DateTime64(6, ''UTC''))') AS ended_at,
            CAST(null, 'Nullable(DateTime64(9, ''UTC''))') AS source_synced_at,
            CAST(null, 'Nullable(UUID)') AS member_activity_id
        WHERE 1 = 0
    {% endif %}
),

stale_activity_members AS (
    SELECT existing_activity_members.*
    FROM existing_activity_members
    LEFT JOIN current_activity_members
        ON current_activity_members.member_activity_id = existing_activity_members.member_activity_id
        AND current_activity_members.user_id = existing_activity_members.user_id
    WHERE current_activity_members.member_activity_id IS null
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    activity_id,
    user_id,
    started_at,
    ended_at,
    source_synced_at,
    member_activity_id,
    refresh_clock.refresh_version AS refresh_version,
    0 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM current_activity_members
CROSS JOIN refresh_clock

UNION ALL

SELECT
    activity_id,
    user_id,
    started_at,
    ended_at,
    source_synced_at,
    member_activity_id,
    refresh_clock.refresh_version AS refresh_version,
    1 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM stale_activity_members
CROSS JOIN refresh_clock
