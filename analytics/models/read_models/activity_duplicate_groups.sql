{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='activity_id',
    query_settings={
        'max_threads': 1
    }
) }}

WITH

current_activities AS (
    SELECT activity_id
    FROM {{ ref('activity_source_records') }} FINAL
    WHERE is_deleted = 0
),

-- These current undirected raw edges remain immutable through every
-- bounded label-propagation round.
current_edges AS (
    SELECT
        duplicate_matches.activity_id,
        duplicate_matches.duplicate_activity_id AS linked_activity_id
    FROM {{ ref('activity_duplicate_matches') }} AS duplicate_matches FINAL
    WHERE duplicate_matches.is_deleted = 0

    UNION ALL

    SELECT
        duplicate_matches.duplicate_activity_id AS activity_id,
        duplicate_matches.activity_id AS linked_activity_id
    FROM {{ ref('activity_duplicate_matches') }} AS duplicate_matches FINAL
    WHERE duplicate_matches.is_deleted = 0
),

graph AS (
    SELECT
        groupArray(current_activities.activity_id) AS activity_ids,
        groupArray((
            current_edges.activity_id,
            current_edges.linked_activity_id
        )) AS edges,
        mapFromArrays(
            groupArray(current_activities.activity_id),
            groupArray(toString(current_activities.activity_id))
        ) AS initial_labels
    FROM current_activities
    LEFT JOIN current_edges
        ON current_edges.activity_id = current_activities.activity_id
),

propagation_16 AS (
    SELECT
        activity_ids,
        edges,
        arrayFold(
            (labels, _) -> mapFromArrays(
                activity_ids,
                arrayMap(
                    activity_id -> arrayMin(arrayConcat(
                        [labels[activity_id]],
                        arrayMap(
                            edge -> labels[tupleElement(edge, 2)],
                            arrayFilter(
                                edge -> tupleElement(edge, 1) = activity_id,
                                edges
                            )
                        )
                    )),
                    activity_ids
                )
            ),
            range(16),
            initial_labels
        ) AS labels
    FROM graph
),

propagation_17 AS (
    SELECT
        activity_ids,
        edges,
        labels AS labels_16,
        arrayFold(
            (labels, _) -> mapFromArrays(
                activity_ids,
                arrayMap(
                    activity_id -> arrayMin(arrayConcat(
                        [labels[activity_id]],
                        arrayMap(
                            edge -> labels[tupleElement(edge, 2)],
                            arrayFilter(
                                edge -> tupleElement(edge, 1) = activity_id,
                                edges
                            )
                        )
                    )),
                    activity_ids
                )
            ),
            range(1),
            labels
        ) AS labels_17
    FROM propagation_16
),

convergence_check AS (
    SELECT throwIf(
        NOT arrayAll(
            activity_id -> labels_16[activity_id] = labels_17[activity_id],
            activity_ids
        ),
        'Activity duplicate component propagation did not converge within 16 rounds'
    ) AS converged
    FROM propagation_17
),

current_duplicate_groups AS (
    SELECT
        activity_id,
        if(
            convergence_check.converged = 0,
            labels_16[activity_id],
            labels_16[activity_id]
        ) AS group_id
    FROM propagation_17
    ARRAY JOIN activity_ids AS activity_id
    CROSS JOIN convergence_check
),

existing_duplicate_groups AS (
    {% if is_incremental() %}
        SELECT activity_id
        FROM {{ this }} FINAL
        WHERE is_deleted = 0
    {% else %}
        SELECT CAST(null, 'Nullable(UUID)') AS activity_id
        WHERE 1 = 0
    {% endif %}
),

stale_duplicate_groups AS (
    SELECT existing_duplicate_groups.activity_id
    FROM existing_duplicate_groups
    LEFT JOIN current_duplicate_groups
        ON current_duplicate_groups.activity_id = existing_duplicate_groups.activity_id
    WHERE current_duplicate_groups.activity_id IS null
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
FROM current_duplicate_groups
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
