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

{% set activity_refresh_scoped = activity_refresh_scope_enabled() %}

WITH ranked AS (
    SELECT *
    FROM {{ ref('activity_source_records') }} FINAL
    WHERE is_deleted = 0
        {% if activity_refresh_scoped %}
        AND user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        {% endif %}
),

final_groups AS (
    SELECT
        activity_id,
        group_id
    FROM {{ ref('activity_duplicate_groups') }} FINAL
    WHERE is_deleted = 0
),

sensor_bearing_members AS (
    SELECT DISTINCT
        samples.user_id AS user_id,
        assumeNotNull(samples.activity_id) AS activity_id
    FROM {{ source('ingest', 'metric_stream_current') }} AS samples FINAL
    INNER JOIN ranked
        ON ranked.user_id = samples.user_id
        AND ranked.activity_id = samples.activity_id
    WHERE samples.is_deleted = 0
        AND samples.activity_id IS NOT null
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
            ranked.canonical_type AS canonical_type,
            ranked.provider_type AS provider_type,
            ranked.modality AS modality,
            ranked.started_at AS started_at,
            ranked.ended_at AS ended_at,
            ranked.source_name AS source_name,
            ranked.priority AS priority,
            sensor_bearing_members.activity_id IS NOT null AS has_sensor_data,
            row_number() OVER (
                PARTITION BY final_groups.group_id
                ORDER BY
                    ranked.canonical_type IN ('other', 'cardio') ASC,
                    if(
                        ranked.provider_type IS NOT null
                        AND trim(BOTH ' ' FROM ranked.provider_type) != ''
                        AND lowerUTF8(ranked.provider_type) != lowerUTF8(ranked.canonical_type),
                        0,
                        1
                    ) ASC,
                    has_sensor_data DESC,
                    ranked.priority ASC,
                    toString(ranked.activity_id) ASC
            ) AS row_number
        FROM final_groups
        INNER JOIN ranked
            ON ranked.activity_id = final_groups.activity_id
        LEFT JOIN sensor_bearing_members
            ON sensor_bearing_members.user_id = ranked.user_id
            AND sensor_bearing_members.activity_id = ranked.activity_id
    )
    WHERE row_number = 1
),

best_context AS (
    SELECT *
    FROM (
        SELECT
            final_groups.group_id AS group_id,
            ranked.timezone AS timezone,
            ranked.start_utc_offset_minutes AS start_utc_offset_minutes,
            ranked.end_utc_offset_minutes AS end_utc_offset_minutes,
            ranked.local_time_source AS local_time_source,
            row_number() OVER (
                PARTITION BY final_groups.group_id
                ORDER BY
                    multiIf(
                        ranked.local_time_source = 'gps_timezone', 1,
                        ranked.local_time_source IN (
                            'provider_timezone',
                            'provider_offset',
                            'device_timezone',
                            'device_offset',
                            'user_home_timezone'
                        ), 2,
                        ranked.local_time_source = 'home_zone_fallback', 3,
                        ranked.local_time_source = 'unknown', 4,
                        5
                    ) ASC,
                    ranked.priority ASC,
                    toString(ranked.activity_id) ASC
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
        any(best.canonical_type) AS canonical_type,
        any(best.provider_type) AS provider_type,
        any(best.modality) AS modality,
        minIf(ranked.started_at, ranked.activity_id IS NOT null) AS started_at,
        maxIf(coalesce(ranked.ended_at, ranked.started_at + INTERVAL 12 HOUR), ranked.activity_id IS NOT null) AS ended_at,
        any(best.source_name) AS source_name,
        argMinIf(ranked.name, ranked.priority, ranked.name IS NOT null) AS name,
        argMinIf(ranked.notes, ranked.priority, ranked.notes IS NOT null) AS notes,
        any(best_context.timezone) AS timezone,
        any(best_context.start_utc_offset_minutes) AS start_utc_offset_minutes,
        any(best_context.end_utc_offset_minutes) AS end_utc_offset_minutes,
        any(best_context.local_time_source) AS local_time_source,
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
    INNER JOIN best_context
        ON best_context.group_id = best.group_id
    GROUP BY best.group_id, best.canonical_id
),

current_deduped_activities AS (
    SELECT
        id AS activity_id,
        provider_id,
        user_id,
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
        coalesce(nullIf(local_time_source, ''), 'unknown') AS local_time_source,
        raw,
        source_synced_at,
        source_providers,
        source_external_ids,
        absent_source_external_ids,
        member_activity_ids
    FROM merged
    WHERE group_id NOT IN (SELECT group_id FROM tombstoned_groups)
),

{% if activity_refresh_scoped %}
prior_scope_member_ids AS (
    {% if is_incremental() %}
        SELECT arrayJoin(member_activity_ids) AS activity_id
        FROM {{ this }} FINAL
        WHERE is_deleted = 0
            AND user_id = toUUID('{{ var("activity_refresh_user_id") }}')
            AND (
                activity_id IN {{ activity_refresh_ids() }}
                OR hasAny(member_activity_ids, {{ activity_refresh_ids() }})
            )
    {% else %}
        SELECT CAST(null, 'Nullable(UUID)') AS activity_id
        WHERE 1 = 0
    {% endif %}
),

affected_member_ids AS (
    SELECT arrayJoin({{ activity_refresh_ids() }}) AS activity_id

    UNION DISTINCT

    SELECT activity_id
    FROM prior_scope_member_ids
),
{% endif %}

scoped_current_deduped_activities AS (
    SELECT *
    FROM current_deduped_activities
    {% if activity_refresh_scoped %}
    WHERE user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND (
            activity_id IN (SELECT activity_id FROM affected_member_ids)
            OR hasAny(
                member_activity_ids,
                CAST((SELECT groupArray(activity_id) FROM affected_member_ids), 'Array(UUID)')
            )
        )
    {% endif %}
)

{% if is_incremental() %}
,
existing_deduped_activities AS (
    SELECT
        deduped.activity_id,
        deduped.provider_id,
        deduped.user_id,
        deduped.canonical_type,
        deduped.provider_type,
        deduped.modality,
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
        {% if activity_refresh_scoped %}
        AND deduped.user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND (
            deduped.activity_id IN (SELECT activity_id FROM affected_member_ids)
            OR hasAny(
                deduped.member_activity_ids,
                CAST((SELECT groupArray(activity_id) FROM affected_member_ids), 'Array(UUID)')
            )
        )
        {% endif %}
),

stale_deduped_activities AS (
    SELECT existing_deduped_activities.*
    FROM existing_deduped_activities
    LEFT JOIN scoped_current_deduped_activities
        ON scoped_current_deduped_activities.activity_id = existing_deduped_activities.activity_id
        AND scoped_current_deduped_activities.user_id = existing_deduped_activities.user_id
    WHERE scoped_current_deduped_activities.activity_id IS null
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
    source_providers,
    source_external_ids,
    absent_source_external_ids,
    member_activity_ids,
    refresh_clock.refresh_version AS refresh_version,
    0 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM scoped_current_deduped_activities
CROSS JOIN refresh_clock

{% if is_incremental() %}
UNION ALL

SELECT
    activity_id,
    provider_id,
    assumeNotNull(user_id) AS user_id,
    activity_id AS primary_activity_id,
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
