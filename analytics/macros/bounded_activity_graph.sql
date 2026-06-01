{% macro bounded_activity_graph() %}
{% set batch_start_value = config.get("__dbt_internal_microbatch_event_time_start") %}
{% set batch_end_value = config.get("__dbt_internal_microbatch_event_time_end") %}
{% if batch_start_value and batch_end_value %}
{% set batch_start = batch_start_value.strftime("%Y-%m-%d %H:%M:%S") %}
{% set batch_end = batch_end_value.strftime("%Y-%m-%d %H:%M:%S") %}
{% endif %}
active_activity AS (
    SELECT *
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    WHERE _peerdb_is_deleted = 0
        {% if batch_start_value and batch_end_value %}
            AND started_at < toDateTime64('{{ batch_end }}', 6, 'UTC')
            AND coalesce(ended_at, started_at + INTERVAL 12 HOUR) >= toDateTime64('{{ batch_start }}', 6, 'UTC')
        {% endif %}
),

{{ activity_dedup_graph() }}
{% endmacro %}

{% macro activity_dedup_graph() %}
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

ranked AS (
    SELECT
        active_activity.id AS id,
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
        active_activity._peerdb_synced_at AS _peerdb_synced_at,
        coalesce(device_priority_match.priority, active_provider_priority.priority, 100) AS priority
    FROM active_activity
    LEFT JOIN active_provider_priority
        ON active_provider_priority.provider_id = active_activity.provider_id
    LEFT JOIN device_priority_match
        ON device_priority_match.activity_id = active_activity.id
),

pairs AS (
    SELECT
        left_activity.id AS id1,
        right_activity.id AS id2
    FROM ranked AS left_activity
    INNER JOIN ranked AS right_activity
        ON left_activity.user_id = right_activity.user_id
        AND toString(left_activity.id) < toString(right_activity.id)
        AND dateDiff(
            'second',
            greatest(left_activity.started_at, right_activity.started_at),
            least(
                coalesce(left_activity.ended_at, left_activity.started_at + INTERVAL 12 HOUR),
                coalesce(right_activity.ended_at, right_activity.started_at + INTERVAL 12 HOUR)
            )
        ) / nullIf(dateDiff(
            'second',
            least(left_activity.started_at, right_activity.started_at),
            greatest(
                coalesce(left_activity.ended_at, left_activity.started_at + INTERVAL 12 HOUR),
                coalesce(right_activity.ended_at, right_activity.started_at + INTERVAL 12 HOUR)
            )
        ), 0) > 0.8
),

graph_edges AS (
    SELECT
        id1 AS from_id,
        id2 AS to_id
    FROM pairs
    UNION ALL
    SELECT
        id2 AS from_id,
        id1 AS to_id
    FROM pairs
),

connected_components AS (
    SELECT
        id AS activity_id,
        id AS connected_activity_id,
        [toString(id)] AS visited_activity_ids
    FROM ranked
    UNION ALL
    SELECT
        connected_components.activity_id AS activity_id,
        graph_edges.to_id AS connected_activity_id,
        arrayConcat(connected_components.visited_activity_ids, [toString(graph_edges.to_id)]) AS visited_activity_ids
    FROM connected_components
    INNER JOIN graph_edges
        ON graph_edges.from_id = connected_components.connected_activity_id
    WHERE NOT has(connected_components.visited_activity_ids, toString(graph_edges.to_id))
),

final_groups AS (
    SELECT
        activity_id,
        min(toString(connected_activity_id)) AS group_id
    FROM connected_components
    GROUP BY activity_id
),

best AS (
    SELECT *
    FROM (
        SELECT
            final_groups.group_id AS group_id,
            ranked.id AS canonical_id,
            ranked.provider_id AS provider_id,
            ranked.user_id AS user_id,
            ranked.activity_type AS activity_type,
            ranked.started_at AS started_at,
            ranked.ended_at AS ended_at,
            ranked.source_name AS source_name,
            ranked.priority AS priority,
            row_number() OVER (
                PARTITION BY final_groups.group_id
                ORDER BY ranked.priority ASC, toString(ranked.id) ASC
            ) AS row_number
        FROM final_groups
        INNER JOIN ranked
            ON ranked.id = final_groups.activity_id
    )
    WHERE row_number = 1
),

merged AS (
    SELECT
        best.group_id AS group_id,
        best.canonical_id AS id,
        any(best.provider_id) AS provider_id,
        any(best.user_id) AS user_id,
        any(best.activity_type) AS activity_type,
        min(ranked.started_at) AS started_at,
        max(coalesce(ranked.ended_at, ranked.started_at + INTERVAL 12 HOUR)) AS ended_at,
        any(best.source_name) AS source_name,
        argMinIf(ranked.name, ranked.priority, ranked.name IS NOT NULL) AS name,
        argMinIf(ranked.notes, ranked.priority, ranked.notes IS NOT NULL) AS notes,
        argMinIf(ranked.timezone, ranked.priority, ranked.timezone IS NOT NULL) AS timezone,
        argMinIf(ranked.raw, ranked.priority, ranked.raw IS NOT NULL) AS raw,
        max(ranked._peerdb_synced_at) AS source_synced_at,
        arraySort(groupUniqArray(ranked.provider_id)) AS source_providers,
        groupArrayIf(
            map('providerId', ranked.provider_id, 'externalId', ranked.external_id),
            ranked.external_id IS NOT NULL AND ranked.external_id != ''
        ) AS source_external_ids,
        groupArray(ranked.id) AS member_activity_ids
    FROM best
    INNER JOIN final_groups
        ON final_groups.group_id = best.group_id
    INNER JOIN ranked
        ON ranked.id = final_groups.activity_id
    GROUP BY best.group_id, best.canonical_id
),

current_activity AS (
    SELECT
        id AS activity_id,
        user_id,
        activity_type,
        name,
        started_at,
        ended_at,
        source_synced_at
    FROM merged
),

activity_members AS (
    SELECT
        id AS activity_id,
        user_id,
        started_at,
        ended_at,
        source_synced_at,
        arrayJoin(member_activity_ids) AS member_activity_id
    FROM merged
)
{% endmacro %}
