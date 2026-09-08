{% set activity_refresh_scoped = activity_refresh_scope_enabled() %}

{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key='source_metric_stream_id',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id, recorded_date, recorded_at, source_metric_stream_id)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

WITH
location_versions AS MATERIALIZED (
    SELECT *
    FROM {{ source('ingest', 'metric_stream_freshness') }}
    WHERE channel = 'location'
        AND (point IS NOT NULL OR is_deleted = 1)
),

{% if is_incremental() %}
target_state AS (
    SELECT
        coalesce(max(refreshed_at), toDateTime64('1970-01-01 00:00:00', 9, 'UTC')) AS last_refreshed_at,
        count() = 0 AS is_empty
    FROM {{ this }}
),
{% endif %}

activity_group_state AS (
    SELECT
        deduped.activity_id AS group_activity_id,
        deduped.user_id,
        deduped.member_activity_ids,
        deduped.is_deleted,
        deduped.refreshed_at
    FROM {{ ref('deduped_activities') }} AS deduped FINAL
),

activity_members AS (
    SELECT
        activity_id,
        user_id,
        source_synced_at,
        member_activity_id
    FROM {{ ref('deduped_activity_members') }} FINAL
    WHERE is_deleted = 0
),

{% if is_incremental() %}
existing_location_samples AS MATERIALIZED (
    SELECT *
    FROM {{ this }} FINAL
    WHERE is_deleted = 0
),
{% endif %}

initial_affected_groups AS (
    SELECT
        activity_group_state.group_activity_id AS activity_id,
        activity_group_state.user_id AS user_id
    FROM activity_group_state
        {% if is_incremental() %}
        CROSS JOIN target_state
        {% endif %}
    WHERE is_deleted = 0
        {% if is_incremental() %}
        AND target_state.is_empty
        {% endif %}
),

changed_location_groups AS (
    {% if is_incremental() %}
    SELECT DISTINCT
        activity_members.activity_id AS activity_id,
        activity_members.user_id AS user_id
    FROM location_versions
    INNER JOIN activity_members
        ON activity_members.member_activity_id = location_versions.activity_id
        AND activity_members.user_id = location_versions.user_id
    CROSS JOIN target_state
    WHERE NOT target_state.is_empty
        AND location_versions.ingested_at > target_state.last_refreshed_at
    {% else %}
    SELECT CAST(null, 'Nullable(UUID)') AS activity_id,
        CAST(null, 'Nullable(UUID)') AS user_id
    WHERE 1 = 0
    {% endif %}
),

changed_group_lifecycle AS (
    {% if is_incremental() %}
    SELECT
        activity_group_state.group_activity_id AS activity_id,
        activity_group_state.user_id AS user_id
    FROM activity_group_state
    CROSS JOIN target_state
    WHERE NOT target_state.is_empty
        AND refreshed_at > target_state.last_refreshed_at
    {% else %}
    SELECT CAST(null, 'Nullable(UUID)') AS activity_id,
        CAST(null, 'Nullable(UUID)') AS user_id
    WHERE 1 = 0
    {% endif %}
),

{% if activity_refresh_scoped %}
scoped_affected_groups AS (
    SELECT
        activity_group_state.group_activity_id AS activity_id,
        activity_group_state.user_id AS user_id
    FROM activity_group_state
    WHERE user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND (
            group_activity_id IN {{ activity_refresh_ids() }}
            OR hasAny(member_activity_ids, {{ activity_refresh_ids() }})
        )

    UNION DISTINCT

    SELECT
        activity_members.activity_id AS activity_id,
        activity_members.user_id AS user_id
    FROM activity_members
    WHERE user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND (
            activity_id IN {{ activity_refresh_ids() }}
            OR member_activity_id IN {{ activity_refresh_ids() }}
        )

    {% if is_incremental() %}
    UNION DISTINCT

    SELECT
        existing_location_samples.activity_id AS activity_id,
        existing_location_samples.user_id AS user_id
    FROM existing_location_samples
    WHERE user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND activity_id IN {{ activity_refresh_ids() }}
    {% endif %}
),
{% endif %}

affected_groups AS MATERIALIZED (
    SELECT DISTINCT assumeNotNull(activity_id) AS activity_id,
        assumeNotNull(user_id) AS user_id
    FROM (
        {% if activity_refresh_scoped %}
        SELECT scoped_affected_groups.activity_id AS activity_id,
            scoped_affected_groups.user_id AS user_id
        FROM scoped_affected_groups
        {% else %}
        SELECT initial_affected_groups.activity_id AS activity_id,
            initial_affected_groups.user_id AS user_id
        FROM initial_affected_groups
        UNION ALL
        SELECT changed_location_groups.activity_id AS activity_id,
            changed_location_groups.user_id AS user_id
        FROM changed_location_groups
        UNION ALL
        SELECT changed_group_lifecycle.activity_id AS activity_id,
            changed_group_lifecycle.user_id AS user_id
        FROM changed_group_lifecycle
        {% endif %}
    )
    WHERE activity_id IS NOT null AND user_id IS NOT null
),

affected_current_members AS MATERIALIZED (
    SELECT
        activity_members.activity_id AS activity_id,
        activity_members.user_id AS user_id,
        activity_members.source_synced_at AS source_synced_at,
        activity_members.member_activity_id AS member_activity_id
    FROM activity_members
    INNER JOIN activity_group_state
        ON activity_group_state.group_activity_id = activity_members.activity_id
        AND activity_group_state.user_id = activity_members.user_id
    WHERE activity_group_state.is_deleted = 0
        AND (activity_members.user_id, activity_members.activity_id) IN (
            SELECT affected_groups.user_id, affected_groups.activity_id
            FROM affected_groups
        )
),

affected_location_state AS MATERIALIZED (
    SELECT
        affected_current_members.activity_id AS activity_id,
        affected_current_members.user_id AS user_id,
        max(affected_current_members.source_synced_at) AS source_synced_at,
        location_versions.id AS id,
        argMax(location_versions.recorded_at, location_versions.version) AS recorded_at,
        argMax(location_versions.provider_id, location_versions.version) AS provider_id,
        argMax(location_versions.point, location_versions.version) AS point,
        argMax(location_versions.ingested_at, location_versions.version) AS ingested_at,
        argMax(location_versions.is_deleted, location_versions.version) AS is_deleted
    FROM location_versions
    INNER JOIN affected_current_members
        ON affected_current_members.member_activity_id = location_versions.activity_id
        AND affected_current_members.user_id = location_versions.user_id
    GROUP BY
        affected_current_members.activity_id,
        affected_current_members.user_id,
        location_versions.id
),

affected_location_rows AS MATERIALIZED (
    SELECT
        *,
        toString(point) AS point_text
    FROM affected_location_state
),

provider_counts AS (
    SELECT
        activity_id,
        provider_id,
        countIf(is_deleted = 0 AND point IS NOT NULL) AS sample_count,
        row_number() OVER (
            PARTITION BY activity_id
            ORDER BY sample_count DESC, provider_id ASC
        ) AS row_number
    FROM affected_location_rows
    GROUP BY activity_id, provider_id
),

best_source AS (
    SELECT activity_id, provider_id
    FROM provider_counts
    WHERE row_number = 1 AND sample_count > 0
),

affected_group_refresh AS MATERIALIZED (
    SELECT
        activity_group_state.group_activity_id AS activity_id,
        activity_group_state.user_id AS user_id,
        greatest(
            max(activity_group_state.refreshed_at),
            maxOrNull(affected_location_rows.source_synced_at),
            maxOrNull(affected_location_rows.ingested_at)
        ) AS source_refreshed_at
    FROM activity_group_state
    LEFT JOIN affected_location_rows
        ON affected_location_rows.activity_id = activity_group_state.group_activity_id
        AND affected_location_rows.user_id = activity_group_state.user_id
    WHERE (activity_group_state.user_id, activity_group_state.group_activity_id) IN (
        SELECT affected_groups.user_id, affected_groups.activity_id
        FROM affected_groups
    )
    GROUP BY activity_group_state.group_activity_id, activity_group_state.user_id
),

current_location_samples AS MATERIALIZED (
    SELECT
        affected_location_rows.activity_id AS activity_id,
        affected_location_rows.user_id AS user_id,
        affected_location_rows.recorded_at AS recorded_at,
        toDate(affected_location_rows.recorded_at) AS recorded_date,
        affected_location_rows.id AS source_metric_stream_id,
        toFloat32(if(
            startsWith(affected_location_rows.point_text, '{'),
            JSONExtract(affected_location_rows.point_text, 'coordinates', 'Array(Float64)')[2],
            toFloat64OrNull(splitByChar(',', trim(BOTH '()' FROM affected_location_rows.point_text))[2])
        )) AS lat,
        toFloat32(if(
            startsWith(affected_location_rows.point_text, '{'),
            JSONExtract(affected_location_rows.point_text, 'coordinates', 'Array(Float64)')[1],
            toFloat64OrNull(splitByChar(',', trim(BOTH '()' FROM affected_location_rows.point_text))[1])
        )) AS lng,
        affected_group_refresh.source_refreshed_at AS source_refreshed_at
    FROM affected_location_rows
    INNER JOIN best_source
        ON best_source.activity_id = affected_location_rows.activity_id
        AND best_source.provider_id = affected_location_rows.provider_id
    INNER JOIN affected_group_refresh
        ON affected_group_refresh.activity_id = affected_location_rows.activity_id
        AND affected_group_refresh.user_id = affected_location_rows.user_id
    WHERE affected_location_rows.is_deleted = 0
        AND affected_location_rows.point IS NOT NULL
),

{% if is_incremental() %}
stale_location_samples AS (
    SELECT
        existing_samples.activity_id AS stale_activity_id,
        existing_samples.user_id AS stale_user_id,
        existing_samples.recorded_at AS stale_recorded_at,
        existing_samples.recorded_date AS stale_recorded_date,
        existing_samples.source_metric_stream_id AS stale_source_metric_stream_id,
        existing_samples.lat AS stale_lat,
        existing_samples.lng AS stale_lng,
        greatest(existing_samples.source_refreshed_at, affected_group_refresh.source_refreshed_at)
            AS stale_source_refreshed_at
    FROM existing_location_samples AS existing_samples
    INNER JOIN affected_group_refresh
        ON affected_group_refresh.activity_id = existing_samples.activity_id
        AND affected_group_refresh.user_id = existing_samples.user_id
    LEFT JOIN current_location_samples
        ON current_location_samples.activity_id = existing_samples.activity_id
        AND current_location_samples.user_id = existing_samples.user_id
        AND current_location_samples.source_metric_stream_id
            = existing_samples.source_metric_stream_id
    WHERE current_location_samples.source_metric_stream_id IS NULL
        AND (existing_samples.user_id, existing_samples.activity_id) IN (
            SELECT affected_groups.user_id, affected_groups.activity_id
            FROM affected_groups
        )
)
{% endif %}

SELECT
    current_location_samples.activity_id,
    current_location_samples.user_id,
    current_location_samples.recorded_at,
    current_location_samples.recorded_date,
    current_location_samples.source_metric_stream_id,
    current_location_samples.lat,
    current_location_samples.lng,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    0 AS is_deleted,
    current_location_samples.source_refreshed_at,
    current_location_samples.source_refreshed_at AS refreshed_at
FROM current_location_samples

{% if is_incremental() %}
UNION ALL

SELECT
    stale_location_samples.stale_activity_id AS activity_id,
    stale_location_samples.stale_user_id AS user_id,
    stale_location_samples.stale_recorded_at AS recorded_at,
    stale_location_samples.stale_recorded_date AS recorded_date,
    stale_location_samples.stale_source_metric_stream_id AS source_metric_stream_id,
    stale_location_samples.stale_lat AS lat,
    stale_location_samples.stale_lng AS lng,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    1 AS is_deleted,
    stale_location_samples.stale_source_refreshed_at AS source_refreshed_at,
    stale_location_samples.stale_source_refreshed_at AS refreshed_at
FROM stale_location_samples
{% endif %}
