{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, sleep_id)',
    query_settings={
        'max_threads': 1
    }
) }}

{% set initial_lookback_days = var('initial_lookback_days', 120) %}

WITH target_state AS (
    SELECT
        {% if is_incremental() %}
            coalesce(
                max(refreshed_at),
                toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
            ) AS last_refreshed_at,
            count() = 0 AS is_empty
        FROM {{ this }}
        {% else %}
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC') AS last_refreshed_at,
            true AS is_empty
        {% endif %}
),

sleep_source AS (
    SELECT
        id AS sleep_id,
        user_id,
        started_at,
        ended_at,
        _peerdb_synced_at,
        _peerdb_is_deleted,
        if(
            ended_at IS NULL,
            CAST(NULL, 'Nullable(Int64)'),
            dateDiff('second', started_at, assumeNotNull(ended_at))
        ) AS duration_seconds,
        multiIf(
            sleep_type IN ('nap', 'late_nap', 'rest'), true,
            sleep_type IN ('sleep', 'long_sleep', 'main'), false,
            sleep_type = 'not_main', coalesce(duration_minutes < 120, true),
            duration_minutes IS NOT NULL, duration_minutes < 120,
            false
        ) AS is_nap
    FROM {{ source('postgres_fitness', 'sleep_session') }} FINAL
),

active_sleep AS (
    SELECT
        sleep_id,
        user_id,
        started_at,
        assumeNotNull(ended_at) AS ended_at,
        assumeNotNull(duration_seconds) AS duration_seconds,
        is_nap
    FROM sleep_source
    WHERE _peerdb_is_deleted = 0
        AND ended_at IS NOT NULL
),

sleep_dirty_keys AS (
    SELECT
        user_id,
        sleep_id
    FROM sleep_source
    WHERE
        {% if is_incremental() %}
            (
                (
                    (SELECT is_empty FROM target_state)
                    AND started_at >= now64(6, 'UTC') - INTERVAL {{ initial_lookback_days }} DAY
                )
                OR (
                    NOT (SELECT is_empty FROM target_state)
                    AND _peerdb_synced_at > (SELECT last_refreshed_at FROM target_state)
                )
            )
        {% else %}
            started_at >= now64(6, 'UTC') - INTERVAL {{ initial_lookback_days }} DAY
        {% endif %}
),

sample_dirty_keys AS (
    SELECT DISTINCT
        user_id,
        sleep_id
    FROM {{ ref('sleep_heart_rate_sample') }}
    WHERE
        {% if is_incremental() %}
            (
                NOT (SELECT is_empty FROM target_state)
                AND refreshed_at > (SELECT last_refreshed_at FROM target_state)
            )
        {% else %}
            1 = 0
        {% endif %}
),

dirty_keys AS (
    SELECT DISTINCT
        user_id,
        sleep_id
    FROM (
        SELECT user_id, sleep_id FROM sleep_dirty_keys
        UNION ALL
        SELECT user_id, sleep_id FROM sample_dirty_keys
    )
),

sleep_windows AS (
    SELECT
        active_sleep.sleep_id AS sleep_id,
        active_sleep.user_id AS user_id,
        active_sleep.started_at AS started_at,
        active_sleep.ended_at AS ended_at,
        active_sleep.duration_seconds AS duration_seconds
    FROM active_sleep
    INNER JOIN dirty_keys
        ON dirty_keys.user_id = active_sleep.user_id
        AND dirty_keys.sleep_id = active_sleep.sleep_id
    WHERE active_sleep.is_nap = false
),

computed_windows AS (
    SELECT
        sleep_samples.sleep_id AS sleep_id,
        sleep_samples.user_id AS user_id,
        any(sleep_samples.started_at) AS started_at,
        any(sleep_samples.ended_at) AS ended_at,
        any(sleep_samples.duration_seconds) AS duration_seconds,
        count() AS sample_count,
        if(
            sample_count >= 30,
            toInt32(round(arrayAvg(arraySlice(
                arraySort(groupArray(toFloat64(sleep_samples.heart_rate))),
                1,
                greatest(toInt32(ceil(sample_count * 0.10)), 1)
            )))),
            CAST(NULL, 'Nullable(Int32)')
        ) AS resting_hr
    FROM {{ ref('sleep_heart_rate_sample') }} AS sleep_samples
    INNER JOIN dirty_keys
        ON dirty_keys.user_id = sleep_samples.user_id
        AND dirty_keys.sleep_id = sleep_samples.sleep_id
    WHERE sleep_samples.is_deleted = 0
        AND sleep_samples.heart_rate IS NOT NULL
    GROUP BY sleep_samples.sleep_id, sleep_samples.user_id
)

SELECT
    dirty_keys.sleep_id AS sleep_id,
    dirty_keys.user_id AS user_id,
    CAST(
        coalesce(computed_windows.started_at, sleep_windows.started_at),
        'Nullable(DateTime64(6, ''UTC''))'
    ) AS started_at,
    CAST(
        coalesce(computed_windows.ended_at, sleep_windows.ended_at),
        'Nullable(DateTime64(6, ''UTC''))'
    ) AS ended_at,
    CAST(
        coalesce(computed_windows.duration_seconds, sleep_windows.duration_seconds),
        'Nullable(Int64)'
    ) AS duration_seconds,
    coalesce(computed_windows.sample_count, 0) AS sample_count,
    CAST(computed_windows.resting_hr, 'Nullable(Int32)') AS resting_hr,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    if(sleep_windows.sleep_id IS NULL OR computed_windows.resting_hr IS NULL, 1, 0) AS is_deleted,
    now64(9, 'UTC') AS refreshed_at
FROM dirty_keys
LEFT JOIN sleep_windows
    ON sleep_windows.user_id = dirty_keys.user_id
    AND sleep_windows.sleep_id = dirty_keys.sleep_id
LEFT JOIN computed_windows
    ON computed_windows.user_id = dirty_keys.user_id
    AND computed_windows.sleep_id = dirty_keys.sleep_id
