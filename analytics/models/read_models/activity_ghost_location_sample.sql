{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key='source_metric_stream_id',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id, recorded_date, recorded_at, source_metric_stream_id)',
    settings={
        'deduplicate_merge_projection_mode': 'rebuild',
        'lightweight_mutation_projection_mode': 'rebuild'
    },
    projections=[{
        'name': 'by_activity_location_source_refresh',
        'query': 'SELECT activity_id, user_id, max(greatest(source_refreshed_at, refreshed_at)) AS source_refreshed_at, max(refresh_version) AS gps_refresh_version GROUP BY activity_id, user_id'
    }],
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1,
        'enable_materialized_cte': 1
    }
) }}

{{ activity_location_sample_query(ghost_eligible=true) }}
