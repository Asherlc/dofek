{{ config(
    materialized='incremental',
    incremental_strategy='microbatch',
    unique_key=['activity_id', 'channel', 'recorded_at'],
    event_time='recorded_at',
    begin='2026-01-01',
    batch_size='day',
    lookback=7,
    full_refresh=false,
    concurrent_batches=false,
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id, recorded_date, channel, recorded_at)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH current_activity AS (
    SELECT
        id AS activity_id,
        user_id,
        started_at,
        coalesce(ended_at, started_at + INTERVAL 12 HOUR) AS ended_at
    FROM {{ source('analytics', 'v_activity') }}
),

activity_samples AS (
    SELECT
        current_activity.activity_id AS activity_id,
        samples.user_id AS user_id,
        samples.recorded_at AS recorded_at,
        samples.recorded_date AS recorded_date,
        samples.channel AS channel,
        samples.scalar AS scalar,
        samples.is_deleted AS is_deleted
    FROM {{ ref('deduped_sensor') }} AS samples
    INNER JOIN current_activity
        ON current_activity.user_id = samples.user_id
        AND samples.recorded_at >= current_activity.started_at
        AND samples.recorded_at <= current_activity.ended_at
)

SELECT
    activity_id,
    user_id,
    recorded_at,
    recorded_date,
    channel,
    scalar,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    is_deleted,
    now64(9) AS refreshed_at
FROM activity_samples
