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
{% set sleep_dirty_key_batch_size = var('sleep_dirty_key_batch_size', 32) %}

WITH
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

activity_source AS (
    SELECT
        id,
        user_id,
        started_at,
        coalesce(ended_at, started_at + INTERVAL 12 HOUR) AS ended_at,
        _peerdb_synced_at,
        _peerdb_is_deleted,
        provider_absent_at,
        deleted_at
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
),

active_activity AS (
    SELECT
        id,
        user_id,
        started_at,
        ended_at
    FROM activity_source
    WHERE _peerdb_is_deleted = 0
        AND provider_absent_at IS NULL
        AND deleted_at IS NULL
),

heart_rate_refreshes AS (
    SELECT
        active_sleep.user_id AS user_id,
        active_sleep.sleep_id AS sleep_id,
        max(samples.refreshed_at) AS heart_rate_refreshed_at
    FROM {{ ref('deduped_sensor') }} AS samples FINAL
    INNER JOIN active_sleep
        ON active_sleep.user_id = samples.user_id
        AND samples.recorded_at >= active_sleep.started_at
        AND samples.recorded_at <= active_sleep.ended_at
    LEFT JOIN active_activity
        ON active_activity.user_id = active_sleep.user_id
        AND samples.recorded_at >= active_activity.started_at
        AND samples.recorded_at <= active_activity.ended_at
    WHERE active_sleep.is_nap = FALSE
        AND samples.channel = 'heart_rate'
    GROUP BY
        active_sleep.user_id,
        active_sleep.sleep_id
    HAVING countIf(samples.is_deleted = 0 AND active_activity.id IS NULL) > 0
),

activity_refreshes AS (
    SELECT
        active_sleep.user_id AS user_id,
        active_sleep.sleep_id AS sleep_id,
        max(activity_source._peerdb_synced_at) AS activity_refreshed_at
    FROM activity_source
    INNER JOIN active_sleep
        ON active_sleep.user_id = activity_source.user_id
        AND activity_source.started_at < active_sleep.ended_at
        AND activity_source.ended_at >= active_sleep.started_at
    WHERE active_sleep.is_nap = FALSE
    GROUP BY
        active_sleep.user_id,
        active_sleep.sleep_id
),

current_sleep_state AS materialized (
    SELECT
        active_sleep.user_id AS user_id,
        active_sleep.sleep_id AS sleep_id,
        active_sleep.started_at AS started_at,
        greatest(
            active_sleep._peerdb_synced_at,
            heart_rate_refreshes.heart_rate_refreshed_at,
            coalesce(
                activity_refreshes.activity_refreshed_at,
                toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
            )
        ) AS source_refreshed_at
    FROM active_sleep
    INNER JOIN heart_rate_refreshes
        ON heart_rate_refreshes.user_id = active_sleep.user_id
        AND heart_rate_refreshes.sleep_id = active_sleep.sleep_id
    LEFT JOIN activity_refreshes
        ON activity_refreshes.user_id = active_sleep.user_id
        AND activity_refreshes.sleep_id = active_sleep.sleep_id
    WHERE active_sleep.is_nap = FALSE
),

existing_sleep_state AS materialized (
    {% if is_incremental() %}
        SELECT
            user_id,
            sleep_id,
            max(refreshed_at) AS refreshed_at,
            countIf(is_deleted = 0) > 0 AS has_active_samples
        FROM {{ this }} FINAL
        GROUP BY
            user_id,
            sleep_id
    {% else %}
        SELECT
            CAST(NULL, 'Nullable(UUID)') AS user_id,
            CAST(NULL, 'Nullable(UUID)') AS sleep_id,
            CAST(NULL, 'Nullable(DateTime64(9, ''UTC''))') AS refreshed_at,
            FALSE AS has_active_samples
        WHERE 1 = 0
    {% endif %}
),

source_dirty_sleep_keys AS (
    SELECT
        current_sleep_state.user_id AS user_id,
        current_sleep_state.sleep_id AS sleep_id
    FROM current_sleep_state
    LEFT JOIN existing_sleep_state
        ON existing_sleep_state.user_id = current_sleep_state.user_id
        AND existing_sleep_state.sleep_id = current_sleep_state.sleep_id
    WHERE (
            existing_sleep_state.sleep_id IS NULL
            AND current_sleep_state.started_at
                >= now64(6, 'UTC') - INTERVAL {{ initial_lookback_days }} DAY
        )
        OR NOT existing_sleep_state.has_active_samples
        OR current_sleep_state.source_refreshed_at > existing_sleep_state.refreshed_at
),

stale_sleep_dirty_keys AS (
    SELECT
        existing_sleep_state.user_id AS user_id,
        existing_sleep_state.sleep_id AS sleep_id
    FROM existing_sleep_state
    LEFT JOIN current_sleep_state
        ON current_sleep_state.user_id = existing_sleep_state.user_id
        AND current_sleep_state.sleep_id = existing_sleep_state.sleep_id
    WHERE existing_sleep_state.has_active_samples
        AND current_sleep_state.sleep_id IS NULL
),

candidate_dirty_keys AS (
    SELECT DISTINCT
        user_id,
        sleep_id
    FROM (
        SELECT
            user_id,
            sleep_id
        FROM source_dirty_sleep_keys
        UNION ALL
        SELECT
            user_id,
            sleep_id
        FROM stale_sleep_dirty_keys
    )
),

dirty_keys AS materialized (
    SELECT
        user_id,
        sleep_id
    FROM candidate_dirty_keys
    ORDER BY
        user_id,
        sleep_id
    LIMIT {{ sleep_dirty_key_batch_size }}
),

active_dirty_sleep AS (
    SELECT
        active_sleep.sleep_id AS sleep_id,
        active_sleep.user_id AS user_id,
        active_sleep.started_at AS started_at,
        active_sleep.ended_at AS ended_at,
        active_sleep.duration_seconds AS duration_seconds,
        greatest(
            active_sleep._peerdb_synced_at,
            coalesce(
                activity_refreshes.activity_refreshed_at,
                toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
            ),
            heart_rate_refreshes.heart_rate_refreshed_at
        ) AS source_refreshed_at
    FROM active_sleep
    INNER JOIN dirty_keys
        ON dirty_keys.user_id = active_sleep.user_id
        AND dirty_keys.sleep_id = active_sleep.sleep_id
    INNER JOIN heart_rate_refreshes
        ON heart_rate_refreshes.user_id = active_sleep.user_id
        AND heart_rate_refreshes.sleep_id = active_sleep.sleep_id
    LEFT JOIN activity_refreshes
        ON activity_refreshes.user_id = active_sleep.user_id
        AND activity_refreshes.sleep_id = active_sleep.sleep_id
    WHERE active_sleep.is_nap = FALSE
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
        greatest(samples.refreshed_at, active_dirty_sleep.source_refreshed_at) AS source_refreshed_at
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

merged_samples AS (
    SELECT
        coalesce(current_samples.sleep_id, existing_samples.sleep_id) AS sleep_id,
        coalesce(current_samples.user_id, existing_samples.user_id) AS user_id,
        if(
            current_samples.sleep_id IS NULL,
            existing_samples.started_at,
            current_samples.started_at
        ) AS started_at,
        if(
            current_samples.sleep_id IS NULL,
            existing_samples.ended_at,
            current_samples.ended_at
        ) AS ended_at,
        if(
            current_samples.sleep_id IS NULL,
            existing_samples.duration_seconds,
            current_samples.duration_seconds
        ) AS duration_seconds,
        coalesce(current_samples.recorded_at, existing_samples.recorded_at) AS recorded_at,
        coalesce(current_samples.recorded_date, existing_samples.recorded_date) AS recorded_date,
        if(
            current_samples.sleep_id IS NULL,
            existing_samples.heart_rate,
            current_samples.heart_rate
        ) AS heart_rate,
        if(current_samples.sleep_id IS NULL, 1, current_samples.is_deleted) AS is_deleted,
        current_samples.source_refreshed_at AS source_refreshed_at,
        current_samples.sleep_id IS NULL AS is_stale
    FROM current_samples
    FULL OUTER JOIN existing_samples
        ON current_samples.user_id = existing_samples.user_id
        AND current_samples.sleep_id = existing_samples.sleep_id
        AND current_samples.recorded_at = existing_samples.recorded_at
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
    if(is_stale, refresh_clock.refreshed_at, source_refreshed_at) AS refreshed_at
FROM merged_samples
CROSS JOIN refresh_clock
