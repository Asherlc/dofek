{% set activity_refresh_scoped = activity_refresh_scope_enabled() %}

{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key='source_metric_stream_id',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id, recorded_date, recorded_at, source_metric_stream_id)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1,
        'enable_materialized_cte': 1
    }
) }}

WITH
activity_group_state AS (
    SELECT
        deduped.activity_id AS group_activity_id,
        deduped.user_id,
        deduped.member_activity_ids,
        deduped.is_deleted,
        deduped.refreshed_at
    FROM {{ ref('deduped_activities') }} AS deduped FINAL
),

{% if is_incremental() %}
existing_group_watermarks AS MATERIALIZED (
    SELECT
        activity_id,
        user_id,
        max(source_refreshed_at) AS source_refreshed_at,
        countIf(is_deleted = 0) AS live_sample_count
    FROM {{ this }} FINAL
    GROUP BY activity_id, user_id
),
{% endif %}

location_point_state AS MATERIALIZED (
    SELECT
        activity_members.activity_id AS activity_id,
        activity_members.user_id AS user_id,
        location_versions.id AS source_metric_stream_id,
        max(location_versions.ingested_at) AS source_refreshed_at,
        argMax(
            tuple(location_versions.point, location_versions.is_deleted),
            location_versions.version
        ) AS latest_location_version
    FROM {{ source('ingest', 'metric_stream_freshness') }} AS location_versions
    INNER JOIN {{ ref('deduped_activity_members') }} AS activity_members FINAL
        ON activity_members.member_activity_id = location_versions.activity_id
        AND activity_members.user_id = location_versions.user_id
    INNER JOIN activity_group_state
        ON activity_group_state.group_activity_id = activity_members.activity_id
        AND activity_group_state.user_id = activity_members.user_id
    WHERE location_versions.channel = 'location'
        AND (location_versions.point IS NOT NULL OR location_versions.is_deleted = 1)
        AND activity_members.is_deleted = 0
        AND activity_group_state.is_deleted = 0
    GROUP BY
        activity_members.activity_id,
        activity_members.user_id,
        location_versions.id
),

location_group_freshness AS MATERIALIZED (
    SELECT
        activity_id,
        user_id,
        max(source_refreshed_at) AS source_refreshed_at,
        countIf(
            latest_location_version.2 = 0
            AND latest_location_version.1 IS NOT NULL
        ) AS live_sample_count
    FROM location_point_state
    GROUP BY activity_id, user_id
),

changed_location_groups AS (
    {% if is_incremental() %}
    SELECT
        location_group_freshness.activity_id AS activity_id,
        location_group_freshness.user_id AS user_id,
        location_group_freshness.source_refreshed_at AS source_refreshed_at
    FROM location_group_freshness
    LEFT JOIN existing_group_watermarks
        ON existing_group_watermarks.activity_id = location_group_freshness.activity_id
        AND existing_group_watermarks.user_id = location_group_freshness.user_id
    WHERE (
        existing_group_watermarks.activity_id IS NULL
        OR location_group_freshness.source_refreshed_at
            > existing_group_watermarks.source_refreshed_at
    )
        AND (
            location_group_freshness.live_sample_count > 0
            OR existing_group_watermarks.live_sample_count > 0
        )
    {% else %}
    SELECT
        activity_id,
        user_id,
        source_refreshed_at
    FROM location_group_freshness
    WHERE live_sample_count > 0
    {% endif %}
),

changed_group_lifecycle AS (
    {% if is_incremental() %}
    SELECT
        activity_group_state.group_activity_id AS activity_id,
        activity_group_state.user_id AS user_id,
        activity_group_state.refreshed_at AS source_refreshed_at
    FROM activity_group_state
    INNER JOIN existing_group_watermarks
        ON existing_group_watermarks.activity_id = activity_group_state.group_activity_id
        AND existing_group_watermarks.user_id = activity_group_state.user_id
    WHERE activity_group_state.refreshed_at > existing_group_watermarks.source_refreshed_at
    {% else %}
    SELECT
        CAST(null, 'Nullable(UUID)') AS activity_id,
        CAST(null, 'Nullable(UUID)') AS user_id,
        CAST(null, 'Nullable(DateTime64(9, ''UTC''))') AS source_refreshed_at
    WHERE 1 = 0
    {% endif %}
),

{% if activity_refresh_scoped %}
scoped_affected_groups AS (
    SELECT
        activity_group_state.group_activity_id AS activity_id,
        activity_group_state.user_id AS user_id
    FROM activity_group_state
    WHERE activity_group_state.user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND (
            activity_group_state.group_activity_id IN {{ activity_refresh_ids() }}
            OR hasAny(activity_group_state.member_activity_ids, {{ activity_refresh_ids() }})
        )

    UNION DISTINCT

    SELECT
        activity_members.activity_id AS activity_id,
        activity_members.user_id AS user_id
    FROM {{ ref('deduped_activity_members') }} AS activity_members FINAL
    WHERE activity_members.user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND activity_members.is_deleted = 0
        AND (
            activity_members.activity_id IN {{ activity_refresh_ids() }}
            OR activity_members.member_activity_id IN {{ activity_refresh_ids() }}
        )

    {% if is_incremental() %}
    UNION DISTINCT

    SELECT
        existing_group_watermarks.activity_id AS activity_id,
        existing_group_watermarks.user_id AS user_id
    FROM existing_group_watermarks
    WHERE existing_group_watermarks.user_id
            = toUUID('{{ var("activity_refresh_user_id") }}')
        AND existing_group_watermarks.activity_id IN {{ activity_refresh_ids() }}
    {% endif %}
),
{% endif %}

candidate_affected_groups AS (
    {% if activity_refresh_scoped %}
    SELECT
        scoped_affected_groups.activity_id AS activity_id,
        scoped_affected_groups.user_id AS user_id,
        toDateTime64('1970-01-01 00:00:00', 9, 'UTC') AS source_refreshed_at
    FROM scoped_affected_groups
    {% else %}
    SELECT
        changed_location_groups.activity_id AS activity_id,
        changed_location_groups.user_id AS user_id,
        changed_location_groups.source_refreshed_at AS source_refreshed_at
    FROM changed_location_groups
    UNION ALL
    SELECT
        changed_group_lifecycle.activity_id AS activity_id,
        changed_group_lifecycle.user_id AS user_id,
        changed_group_lifecycle.source_refreshed_at AS source_refreshed_at
    FROM changed_group_lifecycle
    {% endif %}
),

affected_groups AS MATERIALIZED (
    SELECT
        assumeNotNull(activity_id) AS activity_id,
        assumeNotNull(user_id) AS user_id
    FROM candidate_affected_groups
    WHERE activity_id IS NOT null AND user_id IS NOT null
    GROUP BY activity_id, user_id
    ORDER BY min(source_refreshed_at), user_id, activity_id
    {% if not activity_refresh_scoped %}
    LIMIT {{ var('activity_location_batch_size', 250) }}
    {% endif %}
),

{% if is_incremental() %}
existing_location_samples AS MATERIALIZED (
    SELECT *
    FROM {{ this }} AS existing_samples FINAL
    WHERE existing_samples.is_deleted = 0
        AND (existing_samples.user_id, existing_samples.activity_id) IN (
            SELECT affected_groups.user_id, affected_groups.activity_id
            FROM affected_groups
        )
),
{% endif %}

affected_current_members AS MATERIALIZED (
    SELECT
        activity_members.activity_id AS activity_id,
        activity_members.user_id AS user_id,
        activity_members.source_synced_at AS source_synced_at,
        activity_members.member_activity_id AS member_activity_id
    FROM {{ ref('deduped_activity_members') }} AS activity_members FINAL
    INNER JOIN activity_group_state
        ON activity_group_state.group_activity_id = activity_members.activity_id
        AND activity_group_state.user_id = activity_members.user_id
    WHERE activity_group_state.is_deleted = 0
        AND activity_members.is_deleted = 0
        AND (activity_members.user_id, activity_members.activity_id) IN (
            SELECT affected_groups.user_id, affected_groups.activity_id
            FROM affected_groups
        )
),

affected_location_versions AS (
    SELECT location_versions.*
    FROM {{ source('ingest', 'metric_stream_freshness') }} AS location_versions
    WHERE location_versions.channel = 'location'
        AND (location_versions.point IS NOT NULL OR location_versions.is_deleted = 1)
        AND (location_versions.user_id, location_versions.activity_id) IN (
            SELECT affected_current_members.user_id,
                affected_current_members.member_activity_id
            FROM affected_current_members
        )
),

affected_location_state AS MATERIALIZED (
    SELECT
        affected_current_members.activity_id AS activity_id,
        affected_current_members.user_id AS user_id,
        max(affected_current_members.source_synced_at) AS source_synced_at,
        location_versions.id AS id,
        argMax(
            tuple(
                location_versions.recorded_at,
                location_versions.activity_id,
                location_versions.provider_id,
                location_versions.external_id,
                location_versions.device_id,
                location_versions.source_type,
                location_versions.metadata,
                location_versions.point,
                location_versions.ingested_at,
                location_versions.is_deleted
            ),
            location_versions.version
        ) AS latest_location_version
    FROM affected_location_versions AS location_versions
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
        activity_id,
        user_id,
        source_synced_at,
        id,
        latest_location_version.1 AS recorded_at,
        latest_location_version.2 AS member_activity_id,
        latest_location_version.3 AS provider_id,
        latest_location_version.4 AS source_external_id,
        latest_location_version.5 AS device_id,
        latest_location_version.6 AS source_type,
        latest_location_version.7 AS metadata,
        latest_location_version.8 AS point,
        latest_location_version.9 AS ingested_at,
        latest_location_version.10 AS is_deleted,
        toString(latest_location_version.8) AS point_text
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
        affected_location_rows.member_activity_id AS member_activity_id,
        affected_location_rows.provider_id AS provider_id,
        affected_location_rows.source_external_id AS source_external_id,
        affected_location_rows.device_id AS device_id,
        affected_location_rows.source_type AS source_type,
        multiIf(
            JSONExtractString(affected_location_rows.metadata, 'measurement_kind') = 'direct', 'direct',
            JSONExtractString(affected_location_rows.metadata, 'measurement_kind') = 'estimated', 'estimated',
            'unknown'
        ) AS measurement_kind,
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
        existing_samples.member_activity_id AS stale_member_activity_id,
        existing_samples.provider_id AS stale_provider_id,
        existing_samples.source_external_id AS stale_source_external_id,
        existing_samples.device_id AS stale_device_id,
        existing_samples.source_type AS stale_source_type,
        existing_samples.measurement_kind AS stale_measurement_kind,
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
    current_location_samples.member_activity_id,
    current_location_samples.provider_id,
    current_location_samples.source_external_id,
    current_location_samples.device_id,
    current_location_samples.source_type,
    current_location_samples.measurement_kind,
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
    stale_location_samples.stale_member_activity_id AS member_activity_id,
    stale_location_samples.stale_provider_id AS provider_id,
    stale_location_samples.stale_source_external_id AS source_external_id,
    stale_location_samples.stale_device_id AS device_id,
    stale_location_samples.stale_source_type AS source_type,
    stale_location_samples.stale_measurement_kind AS measurement_kind,
    stale_location_samples.stale_lat AS lat,
    stale_location_samples.stale_lng AS lng,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    1 AS is_deleted,
    stale_location_samples.stale_source_refreshed_at AS source_refreshed_at,
    stale_location_samples.stale_source_refreshed_at AS refreshed_at
FROM stale_location_samples
{% endif %}
