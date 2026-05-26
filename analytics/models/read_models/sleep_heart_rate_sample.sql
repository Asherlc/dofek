{{ config(
    materialized='incremental',
    incremental_strategy='microbatch',
    unique_key=['sleep_id', 'recorded_at'],
    event_time='recorded_at',
    begin='2026-01-01',
    batch_size='day',
    lookback=7,
    full_refresh=false,
    concurrent_batches=false,
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, sleep_id, recorded_date, recorded_at)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH active_sleep AS (
    SELECT
        id AS sleep_id,
        user_id,
        started_at,
        assumeNotNull(ended_at) AS ended_at,
        assumeNotNull(dateDiff('second', started_at, ended_at)) AS duration_seconds,
        multiIf(
            sleep_type IN ('nap', 'late_nap', 'rest'), true,
            sleep_type IN ('sleep', 'long_sleep', 'main'), false,
            sleep_type = 'not_main', coalesce(duration_minutes < 120, true),
            duration_minutes IS NOT null, duration_minutes < 120,
            false
        ) AS is_nap
    FROM {{ source('postgres_fitness', 'sleep_session') }} FINAL
    WHERE _peerdb_is_deleted = 0
        AND ended_at IS NOT null
),

active_activity AS (
    SELECT
        id,
        user_id,
        started_at,
        coalesce(ended_at, started_at + INTERVAL 12 HOUR) AS ended_at
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    WHERE _peerdb_is_deleted = 0
),

sleep_samples AS (
    SELECT
        active_sleep.sleep_id AS sleep_id,
        active_sleep.user_id AS user_id,
        active_sleep.started_at AS started_at,
        active_sleep.ended_at AS ended_at,
        active_sleep.duration_seconds AS duration_seconds,
        samples.recorded_at AS recorded_at,
        samples.recorded_date AS recorded_date,
        samples.scalar AS heart_rate,
        samples.is_deleted AS is_deleted
    FROM {{ ref('deduped_sensor') }} AS samples
    INNER JOIN active_sleep
        ON active_sleep.user_id = samples.user_id
        AND samples.recorded_at >= active_sleep.started_at
        AND samples.recorded_at <= active_sleep.ended_at
    LEFT JOIN active_activity
        ON active_activity.user_id = active_sleep.user_id
        AND samples.recorded_at >= active_activity.started_at
        AND samples.recorded_at <= active_activity.ended_at
    WHERE samples.channel = 'heart_rate'
        AND active_sleep.is_nap = false
        AND active_activity.id IS null
)

SELECT
    sleep_id,
    user_id,
    started_at,
    ended_at,
    duration_seconds,
    recorded_at,
    recorded_date,
    heart_rate,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    is_deleted,
    now64(9) AS refreshed_at
FROM sleep_samples
