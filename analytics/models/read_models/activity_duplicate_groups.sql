{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='activity_id',
    query_settings={
        'max_threads': 1
    }
) }}

WITH source_records AS (
    SELECT activity_id
    FROM {{ ref('activity_source_records') }} FINAL
    WHERE is_deleted = 0
),

duplicate_links AS (
    SELECT
        duplicate_matches.activity_id AS activity_id,
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

duplicate_walk_rows AS (
    -- One bridge collapses provider chains such as Apple Health -> WHOOP -> Strava
    -- into a single real-world activity group without path enumeration.
    SELECT
        activity_id,
        activity_id AS connected_activity_id
    FROM source_records

    UNION ALL

    SELECT
        source_records.activity_id,
        duplicate_links.linked_activity_id AS connected_activity_id
    FROM source_records
    INNER JOIN duplicate_links
        ON duplicate_links.activity_id = source_records.activity_id

    UNION ALL

    SELECT
        source_records.activity_id,
        second_link.linked_activity_id AS connected_activity_id
    FROM source_records
    INNER JOIN duplicate_links AS first_link
        ON first_link.activity_id = source_records.activity_id
    INNER JOIN duplicate_links AS second_link
        ON second_link.activity_id = first_link.linked_activity_id
),

duplicate_walk AS (
    SELECT DISTINCT
        activity_id,
        connected_activity_id
    FROM duplicate_walk_rows
),

current_duplicate_groups AS (
    SELECT
        activity_id,
        min(toString(connected_activity_id)) AS group_id
    FROM duplicate_walk
    GROUP BY activity_id
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
