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

WITH ranked AS (
    SELECT *
    FROM {{ ref('activity_source_records') }} FINAL
    WHERE is_deleted = 0
),

final_groups AS (
    SELECT
        activity_id,
        group_id
    FROM {{ ref('activity_duplicate_groups') }} FINAL
    WHERE is_deleted = 0
),

absent_group_members AS (
    SELECT
        final_groups.group_id AS group_id,
        absent.id AS activity_id,
        absent.provider_id AS provider_id,
        absent.external_id AS external_id,
        absent.provider_absent_at AS provider_absent_at,
        coalesce(
            nullIf(trim(BOTH ' ' FROM JSONExtractString(absent.raw, 'sourceName')), ''),
            nullIf(trim(BOTH ' ' FROM absent.source_name), '')
        ) AS subsource
    FROM final_groups
    INNER JOIN {{ source('postgres_fitness', 'activity') }} AS absent FINAL
        ON absent.id = final_groups.activity_id
        AND absent.deleted_at IS null
        AND absent.provider_absent_at IS NOT null
        AND absent.external_id IS NOT null
        AND absent.external_id != ''
        AND absent._peerdb_is_deleted = 0
),

absent_source_links AS (
    SELECT
        group_id,
        groupArrayIf(
            map(
                'providerId', assumeNotNull(provider_id),
                'externalId', assumeNotNull(external_id),
                'memberActivityId', toString(activity_id),
                'providerAbsentAt', toString(assumeNotNull(provider_absent_at)),
                'subsource', coalesce(subsource, '')
            ),
            provider_id IS NOT null
            AND external_id IS NOT null
            AND external_id != ''
        ) AS absent_source_external_ids
    FROM absent_group_members
    GROUP BY group_id
),

tombstoned_groups AS (
    SELECT DISTINCT group_id
    FROM absent_group_members
),

best AS (
    SELECT *
    FROM (
        SELECT
            final_groups.group_id AS group_id,
            ranked.activity_id AS canonical_id,
            ranked.provider_id AS provider_id,
            ranked.user_id AS user_id,
            ranked.activity_type AS activity_type,
            ranked.started_at AS started_at,
            ranked.ended_at AS ended_at,
            ranked.source_name AS source_name,
            ranked.priority AS priority,
            row_number() OVER (
                PARTITION BY final_groups.group_id
                ORDER BY ranked.priority ASC, toString(ranked.activity_id) ASC
            ) AS row_number
        FROM final_groups
        INNER JOIN ranked
            ON ranked.activity_id = final_groups.activity_id
    )
    WHERE row_number = 1
),

merged AS (
    SELECT
        best.group_id AS group_id,
        best.canonical_id AS id,
        any(best.provider_id) AS provider_id,
        any(best.user_id) AS user_id,
        if(
            countIf(ranked.activity_type = 'rock_climbing') > 0,
            'rock_climbing',
            any(best.activity_type)
        ) AS activity_type,
        minIf(ranked.started_at, ranked.activity_id IS NOT null) AS started_at,
        maxIf(coalesce(ranked.ended_at, ranked.started_at + INTERVAL 12 HOUR), ranked.activity_id IS NOT null) AS ended_at,
        any(best.source_name) AS source_name,
        argMinIf(ranked.name, ranked.priority, ranked.name IS NOT null) AS name,
        argMinIf(ranked.notes, ranked.priority, ranked.notes IS NOT null) AS notes,
        argMinIf(
            ranked.timezone,
            ranked.priority,
            ranked.local_time_source IN ('provider_timezone', 'device_timezone')
        ) AS timezone,
        argMinIf(
            ranked.start_utc_offset_minutes,
            ranked.priority,
            ranked.local_time_source != 'unknown'
        ) AS start_utc_offset_minutes,
        argMinIf(
            ranked.end_utc_offset_minutes,
            ranked.priority,
            ranked.local_time_source != 'unknown'
        ) AS end_utc_offset_minutes,
        argMinIf(
            ranked.local_time_source,
            ranked.priority,
            ranked.local_time_source != 'unknown'
        ) AS local_time_source,
        argMinIf(ranked.raw, ranked.priority, ranked.raw IS NOT null) AS raw,
        maxIf(ranked.source_synced_at, ranked.activity_id IS NOT null) AS source_synced_at,
        arraySort(groupUniqArrayIf(ranked.provider_id, ranked.activity_id IS NOT null)) AS source_providers,
        groupArrayIf(
            map(
                'providerId', ranked.provider_id,
                'externalId', ranked.external_id,
                'memberActivityId', toString(ranked.activity_id),
                'subsource', coalesce(
                    nullIf(trim(BOTH ' ' FROM JSONExtractString(ranked.raw, 'sourceName')), ''),
                    nullIf(trim(BOTH ' ' FROM ranked.source_name), ''),
                    ''
                )
            ),
            ranked.activity_id IS NOT null
            AND ranked.external_id IS NOT null
            AND ranked.external_id != ''
        ) AS source_external_ids,
        coalesce(
            any(absent_source_links.absent_source_external_ids),
            CAST([], 'Array(Map(String, String))')
        ) AS absent_source_external_ids,
        groupArray(final_groups.activity_id) AS member_activity_ids
    FROM best
    INNER JOIN final_groups
        ON final_groups.group_id = best.group_id
    LEFT JOIN ranked
        ON ranked.activity_id = final_groups.activity_id
    LEFT JOIN absent_source_links
        ON absent_source_links.group_id = best.group_id
    GROUP BY best.group_id, best.canonical_id
),

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
        start_utc_offset_minutes,
        end_utc_offset_minutes,
        coalesce(nullIf(local_time_source, ''), 'unknown') AS local_time_source,
        raw,
        source_synced_at,
        source_providers,
        source_external_ids,
        absent_source_external_ids,
        member_activity_ids
    FROM merged
    WHERE group_id NOT IN (SELECT group_id FROM tombstoned_groups)
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
        deduped.start_utc_offset_minutes,
        deduped.end_utc_offset_minutes,
        deduped.local_time_source,
        deduped.raw,
        deduped.source_synced_at,
        deduped.source_providers,
        deduped.source_external_ids,
        deduped.absent_source_external_ids,
        deduped.member_activity_ids
    FROM {{ this }} AS deduped FINAL
    WHERE deduped.is_deleted = 0
),

stale_deduped_activities AS (
    SELECT existing_deduped_activities.*
    FROM existing_deduped_activities
    LEFT JOIN current_deduped_activities
        ON current_deduped_activities.activity_id = existing_deduped_activities.activity_id
        AND current_deduped_activities.user_id = existing_deduped_activities.user_id
    WHERE current_deduped_activities.activity_id IS null
)
{% endif %}

,
refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    activity_id,
    provider_id,
    assumeNotNull(user_id) AS user_id,
    activity_id AS primary_activity_id,
    activity_type,
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
    source_providers,
    source_external_ids,
    absent_source_external_ids,
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
    assumeNotNull(user_id) AS user_id,
    activity_id AS primary_activity_id,
    activity_type,
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
    source_providers,
    source_external_ids,
    absent_source_external_ids,
    member_activity_ids,
    refresh_clock.refresh_version AS refresh_version,
    1 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM stale_deduped_activities
CROSS JOIN refresh_clock
{% endif %}
