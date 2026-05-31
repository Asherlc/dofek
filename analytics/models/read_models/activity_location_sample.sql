{{ config(
    materialized='incremental',
    incremental_strategy='microbatch',
    unique_key='source_metric_stream_id',
    event_time='recorded_at',
    begin='2026-01-01',
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

WITH RECURSIVE {{ bounded_activity_graph() }},

location_versions AS (
    SELECT *
    FROM {{ source('postgres_fitness', 'metric_stream') }}
    WHERE channel = 'location'
        AND (point != '' OR _peerdb_is_deleted = 1)
),

location_rows AS (
    SELECT
        id,
        argMax(activity_id, _peerdb_version) AS member_activity_id,
        argMax(user_id, _peerdb_version) AS user_id,
        argMax(recorded_at, _peerdb_version) AS recorded_at,
        argMax(provider_id, _peerdb_version) AS provider_id,
        (
            JSONExtract(argMax(point, _peerdb_version), 'coordinates', 'Array(Float64)')[1],
            JSONExtract(argMax(point, _peerdb_version), 'coordinates', 'Array(Float64)')[2]
        )::Point AS point,
        argMax(_peerdb_synced_at, _peerdb_version) AS _peerdb_synced_at,
        argMax(_peerdb_is_deleted, _peerdb_version) AS is_deleted
    FROM location_versions
    GROUP BY id
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
)

SELECT
    activity_members.activity_id AS activity_id,
    activity_members.user_id AS user_id,
    location_rows.recorded_at AS recorded_at,
    toDate(location_rows.recorded_at) AS recorded_date,
    location_rows.id AS source_metric_stream_id,
    CAST(location_rows.point.2, 'Nullable(Float32)') AS lat,
    CAST(location_rows.point.1, 'Nullable(Float32)') AS lng,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    location_rows.is_deleted AS is_deleted,
    greatest(location_rows._peerdb_synced_at, activity_members.source_synced_at) AS refreshed_at
FROM location_rows
INNER JOIN activity_members
    ON activity_members.member_activity_id = location_rows.member_activity_id
INNER JOIN best_source
    ON best_source.activity_id = activity_members.activity_id
    AND best_source.provider_id = location_rows.provider_id
