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

WITH target_state AS (
    SELECT
        coalesce(
            max(refreshed_at),
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
        ) AS last_refreshed_at,
        {% if is_incremental() %}(count() = 0){% else %}1{% endif %} AS is_empty
    FROM {% if is_incremental() %}{{ this }}{% else %}(SELECT CAST(null, 'Nullable(DateTime64(9, ''UTC''))') AS refreshed_at){% endif %}
),

changed_deduped_activities AS (
    SELECT deduped_activities.*
    FROM {{ ref('deduped_activities') }} AS deduped_activities FINAL
    WHERE (SELECT is_empty FROM target_state)
        OR deduped_activities.refreshed_at > (SELECT last_refreshed_at FROM target_state)
),

changed_activity_member_keys AS (
    SELECT DISTINCT
        user_id,
        arrayJoin(member_activity_ids) AS member_activity_id
    FROM changed_deduped_activities
),

current_activity_members AS (
    SELECT
        deduped_activities.activity_id AS activity_id,
        deduped_activities.user_id AS user_id,
        deduped_activities.started_at AS started_at,
        deduped_activities.ended_at AS ended_at,
        deduped_activities.source_synced_at AS source_synced_at,
        arrayJoin(deduped_activities.member_activity_ids) AS member_activity_id
    FROM changed_deduped_activities AS deduped_activities
    WHERE deduped_activities.is_deleted = 0
)

{% if is_incremental() %}
,
existing_activity_members AS (
    SELECT
        existing_members.activity_id,
        existing_members.user_id,
        existing_members.started_at,
        existing_members.ended_at,
        existing_members.source_synced_at,
        existing_members.member_activity_id
    FROM {{ this }} AS existing_members FINAL
    WHERE existing_members.is_deleted = 0
        AND (existing_members.user_id, existing_members.member_activity_id) IN (
            SELECT
                user_id,
                member_activity_id
            FROM changed_activity_member_keys
        )
),

stale_activity_members AS (
    SELECT existing_activity_members.*
    FROM existing_activity_members
    LEFT JOIN current_activity_members
        ON current_activity_members.member_activity_id = existing_activity_members.member_activity_id
        AND current_activity_members.user_id = existing_activity_members.user_id
    WHERE current_activity_members.member_activity_id IS null
)
{% endif %}

,
changed_activity_member_count AS (
    SELECT count() AS changed_member_count
    FROM changed_activity_member_keys
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
    FROM target_state
    CROSS JOIN changed_activity_member_count
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

{% if is_incremental() %}
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
{% endif %}
