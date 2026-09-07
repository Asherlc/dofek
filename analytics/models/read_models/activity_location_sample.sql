{% set default_microbatch_begin = run_started_at.strftime('%Y-%m-%d') %}
{% set activity_location_sample_begin = var('activity_location_sample_begin', default_microbatch_begin) %}
{% set activity_refresh_scoped = activity_refresh_scope_enabled() %}

{{ config(
    materialized='incremental',
    incremental_strategy='microbatch',
    unique_key='source_metric_stream_id',
    event_time='refreshed_at',
    begin=activity_location_sample_begin,
    batch_size='day',
    lookback=3,
    full_refresh=false,
    concurrent_batches=false,
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id, recorded_date, recorded_at, source_metric_stream_id)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH activity_group_state AS (
    SELECT
        deduped.activity_id AS group_activity_id,
        deduped.user_id AS user_id,
        deduped.member_activity_ids AS member_activity_ids,
        deduped.refreshed_at AS refreshed_at
    FROM {{ ref('deduped_activities') }} AS deduped FINAL
    WHERE 1 = 1
        {% if activity_refresh_scoped %}
        AND deduped.user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND (
            deduped.activity_id IN {{ activity_refresh_ids() }}
            OR hasAny(deduped.member_activity_ids, {{ activity_refresh_ids() }})
        )
        {% endif %}
),

activity_members AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        ended_at,
        source_synced_at,
        member_activity_id
    FROM {{ ref('deduped_activity_members') }} FINAL
    WHERE is_deleted = 0
        {% if activity_refresh_scoped %}
        AND user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND (
            activity_id IN {{ activity_refresh_ids() }}
            OR member_activity_id IN {{ activity_refresh_ids() }}
        )
        {% endif %}
),

location_versions AS (
    SELECT *
    FROM {{ source('ingest', 'metric_stream_freshness') }}
    WHERE channel = 'location'
        AND (point IS NOT NULL OR is_deleted = 1)
),

location_rows AS (
    SELECT
        id,
        argMax(activity_id, version) AS member_activity_id,
        argMax(user_id, version) AS user_id,
        argMax(recorded_at, version) AS recorded_at,
        argMax(provider_id, version) AS provider_id,
        argMax(point, version) AS point,
        argMax(ingested_at, version) AS ingested_at,
        argMax(is_deleted, version) AS is_deleted
    FROM location_versions
    GROUP BY id
),

location_points AS (
    SELECT
        *,
        toString(point) AS point_text
    FROM location_rows
),

provider_counts AS (
    SELECT
        activity_members.activity_id AS activity_id,
        location_rows.provider_id AS provider_id,
        countIf(location_rows.is_deleted = 0 AND location_rows.point IS NOT NULL) AS sample_count,
        row_number() OVER (
            PARTITION BY activity_members.activity_id
            ORDER BY sample_count DESC, location_rows.provider_id ASC
        ) AS row_number
    FROM location_rows
    INNER JOIN activity_members
        ON activity_members.member_activity_id = location_rows.member_activity_id
    GROUP BY activity_members.activity_id, location_rows.provider_id
),

best_source AS (
    SELECT
        activity_id,
        provider_id
    FROM provider_counts
    WHERE row_number = 1
),

current_location_samples AS (
    SELECT
        activity_members.activity_id AS activity_id,
        activity_members.user_id AS user_id,
        location_rows.recorded_at AS recorded_at,
        toDate(location_rows.recorded_at) AS recorded_date,
        location_rows.id AS source_metric_stream_id,
        toFloat32(if(
            startsWith(location_rows.point_text, '{'),
            JSONExtract(location_rows.point_text, 'coordinates', 'Array(Float64)')[2],
            toFloat64OrNull(splitByChar(',', trim(BOTH '()' FROM location_rows.point_text))[2])
        )) AS lat,
        toFloat32(if(
            startsWith(location_rows.point_text, '{'),
            JSONExtract(location_rows.point_text, 'coordinates', 'Array(Float64)')[1],
            toFloat64OrNull(splitByChar(',', trim(BOTH '()' FROM location_rows.point_text))[1])
        )) AS lng,
        location_rows.is_deleted AS is_deleted,
        greatest(location_rows.ingested_at, activity_members.source_synced_at) AS source_refreshed_at
    FROM location_points AS location_rows
    INNER JOIN activity_members
        ON activity_members.member_activity_id = location_rows.member_activity_id
    INNER JOIN best_source
        ON best_source.activity_id = activity_members.activity_id
        AND best_source.provider_id = location_rows.provider_id
),

{% if is_incremental() %}
current_location_refresh AS (
    SELECT
        activity_id,
        user_id,
        max(source_refreshed_at) AS source_refreshed_at
    FROM current_location_samples
    GROUP BY activity_id, user_id
),

existing_location_samples AS (
    SELECT existing_samples.*
    FROM {{ this }} AS existing_samples FINAL
    INNER JOIN activity_group_state
        ON activity_group_state.group_activity_id = existing_samples.activity_id
        AND activity_group_state.user_id = existing_samples.user_id
    WHERE existing_samples.is_deleted = 0
),

stale_location_samples AS (
    SELECT
        existing_samples.activity_id AS stale_activity_id,
        existing_samples.user_id AS stale_user_id,
        existing_samples.recorded_at AS stale_recorded_at,
        existing_samples.recorded_date AS stale_recorded_date,
        existing_samples.source_metric_stream_id AS stale_source_metric_stream_id,
        existing_samples.lat AS stale_lat,
        existing_samples.lng AS stale_lng,
        greatest(
            existing_samples.source_refreshed_at,
            activity_group_state.refreshed_at,
            current_location_refresh.source_refreshed_at
        ) AS stale_source_refreshed_at
    FROM existing_location_samples AS existing_samples
    INNER JOIN activity_group_state
        ON activity_group_state.group_activity_id = existing_samples.activity_id
        AND activity_group_state.user_id = existing_samples.user_id
    LEFT JOIN current_location_samples
        ON current_location_samples.activity_id = existing_samples.activity_id
        AND current_location_samples.user_id = existing_samples.user_id
        AND current_location_samples.source_metric_stream_id
            = existing_samples.source_metric_stream_id
    LEFT JOIN current_location_refresh
        ON current_location_refresh.activity_id = existing_samples.activity_id
        AND current_location_refresh.user_id = existing_samples.user_id
    WHERE current_location_samples.source_metric_stream_id IS NULL
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
    current_location_samples.is_deleted,
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
