{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, sleep_id, recorded_date, recorded_at)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

{% set initial_lookback_days = var('initial_lookback_days', 120) %}

WITH
{% if is_incremental() %}
target_state AS (
    SELECT
        coalesce(
            max(refreshed_at),
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
        ) AS last_refreshed_at,
        count() = 0 AS is_empty
    FROM {{ this }}
),
{% endif %}

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
            sleep_type IN ('nap', 'late_nap', 'rest'), TRUE,
            sleep_type IN ('sleep', 'long_sleep', 'main'), FALSE,
            sleep_type = 'not_main', coalesce(duration_minutes < 120, TRUE),
            duration_minutes IS NOT NULL, duration_minutes < 120,
            FALSE
        ) AS is_nap
    FROM {{ source('postgres_fitness', 'sleep_session') }} FINAL
),

active_sleep AS (
    SELECT
        sleep_id,
        user_id,
        started_at,
        assumeNotNull(ended_at) AS ended_at,
        _peerdb_synced_at,
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
    WHERE ended_at IS NOT NULL
        {% if is_incremental() %}
            AND NOT (SELECT is_empty FROM target_state)
            AND _peerdb_synced_at > (SELECT last_refreshed_at FROM target_state)
        {% else %}
            AND 1 = 0
        {% endif %}
),

changed_heart_rate_samples AS (
    SELECT
        user_id,
        recorded_at,
        recorded_date,
        refreshed_at,
        scalar,
        is_deleted
    FROM {{ ref('deduped_sensor') }} FINAL
    WHERE channel = 'heart_rate'
        {% if is_incremental() %}
            AND NOT (SELECT is_empty FROM target_state)
            AND refreshed_at > (SELECT last_refreshed_at FROM target_state)
        {% else %}
            AND 1 = 0
        {% endif %}
),

sensor_dirty_keys AS (
    SELECT DISTINCT
        active_sleep.user_id AS user_id,
        active_sleep.sleep_id AS sleep_id
    FROM changed_heart_rate_samples AS samples
    INNER JOIN active_sleep
        ON active_sleep.user_id = samples.user_id
        AND samples.recorded_at >= active_sleep.started_at
        AND samples.recorded_at <= active_sleep.ended_at
    WHERE active_sleep.is_nap = FALSE
),

activity_source AS (
    SELECT
        id,
        user_id,
        started_at,
        coalesce(ended_at, started_at + INTERVAL 12 HOUR) AS ended_at,
        _peerdb_synced_at
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    WHERE _peerdb_is_deleted = 0
        AND provider_absent_at IS NULL
        AND deleted_at IS NULL
),

activity_dirty_keys AS (
    SELECT DISTINCT
        active_sleep.user_id AS user_id,
        active_sleep.sleep_id AS sleep_id
    FROM activity_source
    INNER JOIN active_sleep
        ON active_sleep.user_id = activity_source.user_id
        AND activity_source.started_at < active_sleep.ended_at
        AND activity_source.ended_at >= active_sleep.started_at
    WHERE active_sleep.is_nap = FALSE
        {% if is_incremental() %}
            AND NOT (SELECT is_empty FROM target_state)
            AND activity_source._peerdb_synced_at > (SELECT last_refreshed_at FROM target_state)
        {% else %}
            AND 1 = 0
        {% endif %}
),

initial_dirty_keys AS (
    SELECT
        user_id,
        sleep_id
    FROM active_sleep
    WHERE is_nap = FALSE
        AND (
            {% if is_incremental() %}
                (SELECT is_empty FROM target_state)
            {% else %}
                TRUE
            {% endif %}
        )
        AND started_at >= now64(6, 'UTC') - INTERVAL {{ initial_lookback_days }} DAY
),

existing_sleep_keys AS (
    {% if is_incremental() %}
        SELECT DISTINCT
            user_id,
            sleep_id
        FROM {{ this }} FINAL
        WHERE is_deleted = 0
    {% else %}
        SELECT
            CAST(NULL, 'Nullable(UUID)') AS user_id,
            CAST(NULL, 'Nullable(UUID)') AS sleep_id
        WHERE 1 = 0
    {% endif %}
),

stale_sleep_dirty_keys AS (
    SELECT
        existing_sleep_keys.user_id AS user_id,
        existing_sleep_keys.sleep_id AS sleep_id
    FROM existing_sleep_keys
    LEFT JOIN active_sleep
        ON active_sleep.user_id = existing_sleep_keys.user_id
        AND active_sleep.sleep_id = existing_sleep_keys.sleep_id
        AND active_sleep.is_nap = FALSE
    WHERE active_sleep.sleep_id IS NULL
),

dirty_keys AS (
    SELECT DISTINCT
        user_id,
        sleep_id
    FROM (
        SELECT
            user_id,
            sleep_id
        FROM sleep_dirty_keys
        UNION ALL
        SELECT
            user_id,
            sleep_id
        FROM sensor_dirty_keys
        UNION ALL
        SELECT
            user_id,
            sleep_id
        FROM activity_dirty_keys
        UNION ALL
        SELECT
            user_id,
            sleep_id
        FROM initial_dirty_keys
        UNION ALL
        SELECT
            user_id,
            sleep_id
        FROM stale_sleep_dirty_keys
    )
),

active_dirty_sleep AS (
    SELECT
        active_sleep.sleep_id AS sleep_id,
        active_sleep.user_id AS user_id,
        active_sleep.started_at AS started_at,
        active_sleep.ended_at AS ended_at,
        active_sleep._peerdb_synced_at AS _peerdb_synced_at,
        active_sleep.duration_seconds AS duration_seconds
    FROM active_sleep
    INNER JOIN dirty_keys
        ON dirty_keys.user_id = active_sleep.user_id
        AND dirty_keys.sleep_id = active_sleep.sleep_id
    WHERE active_sleep.is_nap = FALSE
),

sleep_activity_bounds AS (
    SELECT
        user_id,
        min(started_at) AS min_started_at,
        max(ended_at) AS max_ended_at
    FROM active_dirty_sleep
    GROUP BY user_id
),

active_activity AS (
    SELECT
        activity_source.id AS id,
        activity_source.user_id AS user_id,
        activity_source.started_at AS started_at,
        activity_source.ended_at AS ended_at
    FROM activity_source
    INNER JOIN sleep_activity_bounds AS bounds
        ON bounds.user_id = activity_source.user_id
    WHERE activity_source.started_at < bounds.max_ended_at
        AND activity_source.ended_at >= bounds.min_started_at
),

current_samples AS (
    SELECT
        active_dirty_sleep.sleep_id AS sleep_id,
        active_dirty_sleep.user_id AS user_id,
        active_dirty_sleep.started_at AS started_at,
        active_dirty_sleep.ended_at AS ended_at,
        active_dirty_sleep.duration_seconds AS duration_seconds,
        samples.recorded_at AS recorded_at,
        samples.recorded_date AS recorded_date,
        samples.scalar AS heart_rate,
        samples.is_deleted AS is_deleted,
        greatest(samples.refreshed_at, active_dirty_sleep._peerdb_synced_at) AS source_refreshed_at
    FROM {{ ref('deduped_sensor') }} AS samples
    INNER JOIN active_dirty_sleep
        ON active_dirty_sleep.user_id = samples.user_id
        AND samples.recorded_at >= active_dirty_sleep.started_at
        AND samples.recorded_at <= active_dirty_sleep.ended_at
    LEFT JOIN active_activity
        ON active_activity.user_id = active_dirty_sleep.user_id
        AND samples.recorded_at >= active_activity.started_at
        AND samples.recorded_at <= active_activity.ended_at
    WHERE samples.channel = 'heart_rate'
        AND active_activity.id IS NULL
),

existing_samples AS (
    {% if is_incremental() %}
        SELECT
            sleep_id,
            user_id,
            started_at,
            ended_at,
            duration_seconds,
            recorded_at,
            recorded_date,
            heart_rate
        FROM {{ this }} FINAL
        WHERE is_deleted = 0
            AND (user_id, sleep_id) IN (
                SELECT
                    user_id,
                    sleep_id
                FROM dirty_keys
            )
    {% else %}
        SELECT
            CAST(NULL, 'Nullable(UUID)') AS sleep_id,
            CAST(NULL, 'Nullable(UUID)') AS user_id,
            CAST(NULL, 'Nullable(DateTime64(6, ''UTC''))') AS started_at,
            CAST(NULL, 'Nullable(DateTime64(6, ''UTC''))') AS ended_at,
            CAST(NULL, 'Nullable(Int64)') AS duration_seconds,
            CAST(NULL, 'Nullable(DateTime64(6, ''UTC''))') AS recorded_at,
            CAST(NULL, 'Nullable(Date)') AS recorded_date,
            CAST(NULL, 'Nullable(Float32)') AS heart_rate
        WHERE 1 = 0
    {% endif %}
),

stale_sample_tombstones AS (
    SELECT
        existing_samples.sleep_id AS sleep_id,
        existing_samples.user_id AS user_id,
        existing_samples.started_at AS started_at,
        existing_samples.ended_at AS ended_at,
        existing_samples.duration_seconds AS duration_seconds,
        existing_samples.recorded_at AS recorded_at,
        existing_samples.recorded_date AS recorded_date,
        existing_samples.heart_rate AS heart_rate
    FROM existing_samples
    LEFT JOIN current_samples
        ON current_samples.user_id = existing_samples.user_id
        AND current_samples.sleep_id = existing_samples.sleep_id
        AND current_samples.recorded_at = existing_samples.recorded_at
        AND current_samples.is_deleted = 0
    WHERE current_samples.recorded_at IS NULL
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9, 'UTC') AS refreshed_at
)

SELECT
    assumeNotNull(sleep_id) AS sleep_id,
    assumeNotNull(user_id) AS user_id,
    started_at,
    ended_at,
    duration_seconds,
    assumeNotNull(recorded_at) AS recorded_at,
    assumeNotNull(recorded_date) AS recorded_date,
    heart_rate,
    refresh_clock.refresh_version AS refresh_version,
    is_deleted,
    source_refreshed_at AS refreshed_at
FROM current_samples
CROSS JOIN refresh_clock

UNION ALL

SELECT
    assumeNotNull(sleep_id) AS sleep_id,
    assumeNotNull(user_id) AS user_id,
    started_at,
    ended_at,
    duration_seconds,
    assumeNotNull(recorded_at) AS recorded_at,
    assumeNotNull(recorded_date) AS recorded_date,
    heart_rate,
    refresh_clock.refresh_version AS refresh_version,
    1 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM stale_sample_tombstones
CROSS JOIN refresh_clock
