{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='activity_id',
    query_settings={
        'max_threads': 1
    }
) }}

{% set activity_refresh_scoped = activity_refresh_scope_enabled() %}

WITH

current_activities AS (
    SELECT
        activity_id,
        user_id
    FROM {{ ref('activity_source_records') }} FINAL
    WHERE is_deleted = 0
        {% if activity_refresh_scoped %}
        AND user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        {% endif %}
),

-- Retain only current edges whose two active endpoints belong to the same user.
-- This immutable edge set is shared by all bounded propagation rounds.
current_edges AS (
    SELECT
        source_activity.user_id AS user_id,
        source_activity.activity_id AS activity_id,
        duplicate_activity.activity_id AS linked_activity_id
    FROM {{ ref('activity_duplicate_matches') }} AS duplicate_matches FINAL
    INNER JOIN current_activities AS source_activity
        ON source_activity.activity_id = duplicate_matches.activity_id
    INNER JOIN current_activities AS duplicate_activity
        ON duplicate_activity.activity_id = duplicate_matches.duplicate_activity_id
        AND duplicate_activity.user_id = source_activity.user_id
    WHERE duplicate_matches.is_deleted = 0

    UNION ALL

    SELECT
        duplicate_activity.user_id AS user_id,
        duplicate_activity.activity_id AS activity_id,
        source_activity.activity_id AS linked_activity_id
    FROM {{ ref('activity_duplicate_matches') }} AS duplicate_matches FINAL
    INNER JOIN current_activities AS source_activity
        ON source_activity.activity_id = duplicate_matches.activity_id
    INNER JOIN current_activities AS duplicate_activity
        ON duplicate_activity.activity_id = duplicate_matches.duplicate_activity_id
        AND duplicate_activity.user_id = source_activity.user_id
    WHERE duplicate_matches.is_deleted = 0
),

adjacency_with_nodes AS (
    SELECT
        user_id,
        activity_id,
        arrayFlatten(groupArray(linked_activity_ids)) AS linked_activity_ids
    FROM (
        SELECT
            user_id,
            activity_id,
            CAST([], 'Array(UUID)') AS linked_activity_ids
        FROM current_activities

        UNION ALL

        SELECT
            user_id,
            activity_id,
            [linked_activity_id] AS linked_activity_ids
        FROM current_edges
    )
    GROUP BY user_id, activity_id
),

graph_entries AS (
    SELECT
        user_id,
        groupArray(tuple(activity_id, linked_activity_ids)) AS entries
    FROM adjacency_with_nodes
    GROUP BY user_id
),

graph AS (
    SELECT
        user_id,
        arrayMap(entry -> entry.1, entries) AS activity_ids,
        arrayMap(entry -> entry.2, entries) AS linked_activity_ids_by_activity,
        mapFromArrays(
            arrayMap(entry -> entry.1, entries),
            arrayMap(entry -> toString(entry.1), entries)
        ) AS initial_labels
    FROM graph_entries
),

propagation_64 AS (
    SELECT
        user_id,
        activity_ids,
        linked_activity_ids_by_activity,
        arrayFold(
            (labels, _) -> mapFromArrays(
                activity_ids,
                arrayMap(
                    (activity_id, linked_activity_ids) -> arrayMin(arrayConcat(
                        [labels[activity_id]],
                        arrayMap(
                            linked_activity_id -> labels[linked_activity_id],
                            linked_activity_ids
                        )
                    )),
                    activity_ids,
                    linked_activity_ids_by_activity
                )
            ),
            range(64),
            initial_labels
        ) AS labels
    FROM graph
),

propagation_65 AS (
    SELECT
        user_id,
        activity_ids,
        linked_activity_ids_by_activity,
        labels AS labels_64,
        arrayFold(
            (labels, _) -> mapFromArrays(
                activity_ids,
                arrayMap(
                    (activity_id, linked_activity_ids) -> arrayMin(arrayConcat(
                        [labels[activity_id]],
                        arrayMap(
                            linked_activity_id -> labels[linked_activity_id],
                            linked_activity_ids
                        )
                    )),
                    activity_ids,
                    linked_activity_ids_by_activity
                )
            ),
            range(1),
            labels
        ) AS labels_65
    FROM propagation_64
),

convergence_check AS (
    SELECT throwIf(
        countIf(NOT arrayAll(
            activity_id -> labels_64[activity_id] = labels_65[activity_id],
            activity_ids
        )) > 0,
        'Activity duplicate component propagation did not converge within 64 rounds'
    ) AS converged
    FROM propagation_65
),

current_duplicate_groups AS (
    SELECT
        activity_id,
        concat(
            labels_64[activity_id],
            substring('', 1, convergence_check.converged)
        ) AS group_id
    FROM propagation_65
    ARRAY JOIN activity_ids AS activity_id
    CROSS JOIN convergence_check
),

{% if activity_refresh_scoped %}
prior_scope_group_ids AS (
    {% if is_incremental() %}
        SELECT DISTINCT group_id
        FROM {{ this }} FINAL
        WHERE is_deleted = 0
            AND activity_id IN {{ activity_refresh_ids() }}
            AND group_id IS NOT null
    {% else %}
        SELECT CAST(null, 'Nullable(String)') AS group_id
        WHERE 1 = 0
    {% endif %}
),

current_scope_group_ids AS (
    {% if activity_refresh_scoped %}
        SELECT DISTINCT group_id
        FROM current_duplicate_groups
        WHERE activity_id IN {{ activity_refresh_ids() }}
    {% else %}
        SELECT CAST(null, 'Nullable(String)') AS group_id
        WHERE 1 = 0
    {% endif %}
),

affected_activity_ids AS (
    SELECT activity_id
    FROM current_duplicate_groups
    WHERE group_id IN (SELECT group_id FROM current_scope_group_ids)

    {% if is_incremental() %}
    UNION DISTINCT

    SELECT activity_id
    FROM {{ this }} FINAL
    WHERE is_deleted = 0
        AND group_id IN (SELECT group_id FROM prior_scope_group_ids)
    {% endif %}
),
{% endif %}

scoped_current_duplicate_groups AS (
    SELECT *
    FROM current_duplicate_groups
    {% if activity_refresh_scoped %}
    WHERE activity_id IN (SELECT activity_id FROM affected_activity_ids)
    {% endif %}
),

existing_duplicate_groups AS (
    {% if is_incremental() %}
        SELECT activity_id
        FROM {{ this }} FINAL
        WHERE is_deleted = 0
            {% if activity_refresh_scoped %}
            AND activity_id IN (SELECT activity_id FROM affected_activity_ids)
            {% endif %}
    {% else %}
        SELECT CAST(null, 'Nullable(UUID)') AS activity_id
        WHERE 1 = 0
    {% endif %}
),

stale_duplicate_groups AS (
    SELECT existing_duplicate_groups.activity_id
    FROM existing_duplicate_groups
    LEFT ANTI JOIN scoped_current_duplicate_groups
        ON scoped_current_duplicate_groups.activity_id = existing_duplicate_groups.activity_id
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    activity_id,
    group_id,
    refresh_clock.refresh_version AS refresh_version,
    0 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM scoped_current_duplicate_groups
CROSS JOIN refresh_clock

UNION ALL

SELECT
    assumeNotNull(activity_id) AS activity_id,
    CAST(null, 'Nullable(String)') AS group_id,
    refresh_clock.refresh_version AS refresh_version,
    1 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM stale_duplicate_groups
CROSS JOIN refresh_clock
