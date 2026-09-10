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

WITH current_duplicate_groups AS (
    SELECT
        source_records.activity_id AS activity_id,
        toString(source_records.group_id) AS group_id
    FROM {{ ref('activity_source_records') }} AS source_records FINAL
    WHERE source_records.is_deleted = 0
        AND throwIf(
            source_records.group_id IS null
            OR source_records.group_id = toUUID('00000000-0000-0000-0000-000000000000'),
            'Active activity source record is missing persisted group_id'
        ) = 0
        {% if activity_refresh_scoped %}
        AND source_records.user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        {% endif %}
),

{% if activity_refresh_scoped %}
prior_scope_group_ids AS (
    {% if is_incremental() %}
        SELECT DISTINCT group_id
        FROM {{ this }} FINAL
        WHERE is_deleted = 0
            AND (
                activity_id IN {{ activity_refresh_ids() }}
                OR toUUID(group_id) IN {{ activity_refresh_ids() }}
            )
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
            OR toUUID(group_id) IN {{ activity_refresh_ids() }}
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
