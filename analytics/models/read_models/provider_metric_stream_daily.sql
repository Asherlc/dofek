{% set provider_metric_stream_day_batch_size = var('provider_metric_stream_day_batch_size', 32) %}

{{ config(
    materialized='incremental',
    incremental_strategy='append',
    full_refresh=false,
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, provider_id, recorded_date)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1,
        'enable_materialized_cte': 1,
        'preferred_optimize_projection_name': 'by_provider_current_state_recorded_at'
    }
) }}

WITH source_day_changes AS MATERIALIZED (
    SELECT
        user_id,
        provider_id,
        recorded_date,
        max(changed_at) AS source_changed_at
    FROM {{ source('analytics', 'metric_stream_day_change') }}
    GROUP BY
        user_id,
        provider_id,
        recorded_date
),

{% if is_incremental() %}
existing_daily_state AS MATERIALIZED (
    SELECT
        user_id,
        provider_id,
        recorded_date,
        source_changed_at
    FROM {{ this }} FINAL
),
{% endif %}

dirty_days AS MATERIALIZED (
    SELECT
        source_day_changes.user_id AS user_id,
        source_day_changes.provider_id AS provider_id,
        source_day_changes.recorded_date AS recorded_date,
        source_day_changes.source_changed_at AS source_changed_at
    FROM source_day_changes
    {% if is_incremental() %}
    LEFT JOIN existing_daily_state
        ON existing_daily_state.user_id = source_day_changes.user_id
        AND existing_daily_state.provider_id = source_day_changes.provider_id
        AND existing_daily_state.recorded_date = source_day_changes.recorded_date
    WHERE existing_daily_state.recorded_date IS NULL
        OR source_day_changes.source_changed_at > existing_daily_state.source_changed_at
    {% endif %}
    ORDER BY
        source_day_changes.source_changed_at,
        source_day_changes.user_id,
        source_day_changes.provider_id,
        source_day_changes.recorded_date
    LIMIT {{ provider_metric_stream_day_batch_size }}
),

metric_stream_current AS MATERIALIZED (
    SELECT
        user_id,
        provider_id,
        id,
        tupleElement(latest_state, 1) AS recorded_at,
        tupleElement(latest_state, 4) AS is_deleted
    FROM (
        SELECT
            user_id,
            provider_id,
            id,
            argMax(
                tuple(recorded_at, ingested_at, version, is_deleted),
                tuple(version, ingested_at)
            ) AS latest_state
        FROM {{ source('ingest', 'metric_stream_current') }}
        WHERE (user_id, provider_id, toDate(recorded_at)) IN (
            SELECT
                user_id,
                provider_id,
                recorded_date
            FROM dirty_days
        )
        GROUP BY
            user_id,
            provider_id,
            id
    )
),

metric_stream_counts AS (
    SELECT
        dirty_days.user_id AS user_id,
        dirty_days.provider_id AS provider_id,
        dirty_days.recorded_date AS recorded_date,
        countIf(metric_stream_current.is_deleted = 0) AS metric_stream_count
    FROM dirty_days
    LEFT JOIN metric_stream_current
        ON metric_stream_current.user_id = dirty_days.user_id
        AND metric_stream_current.provider_id = dirty_days.provider_id
        AND toDate(metric_stream_current.recorded_at) = dirty_days.recorded_date
    GROUP BY
        dirty_days.user_id,
        dirty_days.provider_id,
        dirty_days.recorded_date
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9, 'UTC') AS refreshed_at
)

SELECT
    metric_stream_counts.user_id AS user_id,
    metric_stream_counts.provider_id AS provider_id,
    metric_stream_counts.recorded_date AS recorded_date,
    coalesce(metric_stream_counts.metric_stream_count, 0) AS metric_stream_count,
    dirty_days.source_changed_at AS source_changed_at,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM metric_stream_counts
INNER JOIN dirty_days
    ON dirty_days.user_id = metric_stream_counts.user_id
    AND dirty_days.provider_id = metric_stream_counts.provider_id
    AND dirty_days.recorded_date = metric_stream_counts.recorded_date
CROSS JOIN refresh_clock
