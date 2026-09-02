{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, sleep_id)',
    full_refresh=false,
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1,
        'enable_materialized_cte': 1
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

completed_sleep AS MATERIALIZED (
    SELECT
        sleep_id,
        user_id,
        started_at,
        assumeNotNull(ended_at) AS ended_at,
        assumeNotNull(duration_seconds) AS duration_seconds,
        _peerdb_synced_at,
        _peerdb_is_deleted AS source_is_deleted
    FROM sleep_source
    WHERE ended_at IS NOT NULL
        AND is_nap = FALSE
),

cutover AS (
    SELECT max(cutover_at) AS cutover_at
    FROM {{ source('analytics', 'sleep_heart_rate_cutover') }}
),

activity_source AS MATERIALIZED (
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

heart_rate_changes AS (
    SELECT
        completed_sleep.user_id AS user_id,
        completed_sleep.sleep_id AS sleep_id,
        max(day_change.changed_at) AS heart_rate_changed_at
    FROM completed_sleep
    INNER JOIN {{ source('analytics', 'heart_rate_day_change') }} AS day_change
        ON day_change.user_id = completed_sleep.user_id
        AND day_change.recorded_date >= toDate(completed_sleep.started_at)
        AND day_change.recorded_date <= toDate(completed_sleep.ended_at)
    GROUP BY
        completed_sleep.user_id,
        completed_sleep.sleep_id
),

activity_changes AS (
    SELECT
        completed_sleep.user_id AS user_id,
        completed_sleep.sleep_id AS sleep_id,
        max(activity_source._peerdb_synced_at) AS activity_changed_at
    FROM completed_sleep
    INNER JOIN activity_source
        ON activity_source.user_id = completed_sleep.user_id
        AND activity_source.started_at <= completed_sleep.ended_at
        AND activity_source.ended_at >= completed_sleep.started_at
    GROUP BY
        completed_sleep.user_id,
        completed_sleep.sleep_id
),

current_sleep_state AS MATERIALIZED (
    SELECT
        completed_sleep.sleep_id AS sleep_id,
        completed_sleep.user_id AS user_id,
        completed_sleep.started_at AS started_at,
        completed_sleep.ended_at AS ended_at,
        completed_sleep.duration_seconds AS duration_seconds,
        completed_sleep.source_is_deleted AS source_is_deleted,
        greatest(
            completed_sleep._peerdb_synced_at,
            coalesce(
                heart_rate_changes.heart_rate_changed_at,
                toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
            ),
            coalesce(
                activity_changes.activity_changed_at,
                toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
            )
        ) AS source_changed_at
    FROM completed_sleep
    LEFT JOIN heart_rate_changes
        ON heart_rate_changes.user_id = completed_sleep.user_id
        AND heart_rate_changes.sleep_id = completed_sleep.sleep_id
    LEFT JOIN activity_changes
        ON activity_changes.user_id = completed_sleep.user_id
        AND activity_changes.sleep_id = completed_sleep.sleep_id
),

existing_sleep_state AS MATERIALIZED (
    {% if is_incremental() %}
        SELECT
            sleep_id,
            user_id,
            started_at,
            ended_at,
            duration_seconds,
            source_changed_at,
            is_deleted
        FROM {{ this }} FINAL
    {% else %}
        SELECT
            CAST(NULL, 'Nullable(UUID)') AS sleep_id,
            CAST(NULL, 'Nullable(UUID)') AS user_id,
            CAST(NULL, 'Nullable(DateTime64(6, ''UTC''))') AS started_at,
            CAST(NULL, 'Nullable(DateTime64(6, ''UTC''))') AS ended_at,
            CAST(NULL, 'Nullable(Int64)') AS duration_seconds,
            CAST(NULL, 'Nullable(DateTime64(9, ''UTC''))') AS source_changed_at,
            CAST(NULL, 'Nullable(UInt8)') AS is_deleted
        WHERE 1 = 0
    {% endif %}
),

source_dirty_sleep_keys AS (
    SELECT
        current_sleep_state.user_id AS user_id,
        current_sleep_state.sleep_id AS sleep_id,
        current_sleep_state.source_changed_at AS source_changed_at,
        if(existing_sleep_state.sleep_id IS NULL, 1, 0) AS bootstrap_priority
    FROM current_sleep_state
    LEFT JOIN existing_sleep_state
        ON existing_sleep_state.user_id = current_sleep_state.user_id
        AND existing_sleep_state.sleep_id = current_sleep_state.sleep_id
    WHERE (
            existing_sleep_state.sleep_id IS NULL
            AND (
                current_sleep_state.started_at
                    >= now64(6, 'UTC') - INTERVAL {{ initial_lookback_days }} DAY
                OR current_sleep_state.source_changed_at >= (SELECT cutover_at FROM cutover)
            )
        )
        OR (
            existing_sleep_state.is_deleted = 1
            AND current_sleep_state.source_is_deleted = 0
        )
        OR current_sleep_state.source_changed_at > existing_sleep_state.source_changed_at
),

stale_sleep_dirty_keys AS (
    SELECT
        existing_sleep_state.user_id AS user_id,
        existing_sleep_state.sleep_id AS sleep_id,
        existing_sleep_state.source_changed_at AS source_changed_at,
        0 AS bootstrap_priority
    FROM existing_sleep_state
    LEFT JOIN current_sleep_state
        ON current_sleep_state.user_id = existing_sleep_state.user_id
        AND current_sleep_state.sleep_id = existing_sleep_state.sleep_id
    WHERE existing_sleep_state.is_deleted = 0
        AND current_sleep_state.sleep_id IS NULL
),

dirty_keys AS MATERIALIZED (
    SELECT
        user_id,
        sleep_id
    FROM (
        SELECT
            user_id,
            sleep_id,
            source_changed_at,
            bootstrap_priority
        FROM source_dirty_sleep_keys
        UNION ALL
        SELECT
            user_id,
            sleep_id,
            source_changed_at,
            bootstrap_priority
        FROM stale_sleep_dirty_keys
    )
    ORDER BY
        bootstrap_priority,
        source_changed_at,
        user_id,
        sleep_id
    LIMIT {{ sleep_dirty_key_batch_size }}
),

active_dirty_sleep AS MATERIALIZED (
    SELECT
        current_sleep_state.sleep_id AS sleep_id,
        current_sleep_state.user_id AS user_id,
        current_sleep_state.started_at AS started_at,
        current_sleep_state.ended_at AS ended_at,
        current_sleep_state.duration_seconds AS duration_seconds,
        current_sleep_state.source_changed_at AS source_changed_at
    FROM current_sleep_state
    INNER JOIN dirty_keys
        ON dirty_keys.user_id = current_sleep_state.user_id
        AND dirty_keys.sleep_id = current_sleep_state.sleep_id
    WHERE current_sleep_state.source_is_deleted = 0
),

dirty_sleep_dates AS (
    SELECT DISTINCT
        user_id,
        arrayJoin(
            arrayMap(
                day_offset -> toDate(started_at) + day_offset,
                range(
                    toUInt32(
                        greatest(0, dateDiff('day', toDate(started_at), toDate(ended_at)))
                    ) + 1
                )
            )
        ) AS recorded_date
    FROM active_dirty_sleep
),

current_windows AS (
    SELECT
        active_dirty_sleep.sleep_id AS sleep_id,
        active_dirty_sleep.user_id AS user_id,
        active_dirty_sleep.started_at AS started_at,
        active_dirty_sleep.ended_at AS ended_at,
        active_dirty_sleep.duration_seconds AS duration_seconds,
        countIf(
            samples.user_id IS NOT NULL
                AND samples.is_deleted = 0
                AND samples.scalar IS NOT NULL
                AND overlapping_activity.id IS NULL
        ) AS eligible_sample_count,
        active_dirty_sleep.source_changed_at AS source_changed_at
    FROM active_dirty_sleep
    LEFT JOIN {{ ref('deduped_sensor') }} AS samples FINAL
        ON samples.user_id = active_dirty_sleep.user_id
        AND samples.recorded_at >= active_dirty_sleep.started_at
        AND samples.recorded_at <= active_dirty_sleep.ended_at
        AND samples.channel = 'heart_rate'
        AND (samples.user_id, samples.recorded_date) IN (
            SELECT
                user_id,
                recorded_date
            FROM dirty_sleep_dates
        )
    LEFT JOIN activity_source AS overlapping_activity
        ON overlapping_activity.user_id = active_dirty_sleep.user_id
        AND overlapping_activity.started_at <= samples.recorded_at
        AND overlapping_activity.ended_at >= samples.recorded_at
        AND overlapping_activity._peerdb_is_deleted = 0
        AND overlapping_activity.provider_absent_at IS NULL
        AND overlapping_activity.deleted_at IS NULL
    GROUP BY
        active_dirty_sleep.sleep_id,
        active_dirty_sleep.user_id,
        active_dirty_sleep.started_at,
        active_dirty_sleep.ended_at,
        active_dirty_sleep.duration_seconds,
        active_dirty_sleep.source_changed_at
),

stale_windows AS (
    SELECT
        current_sleep_state.sleep_id AS sleep_id,
        current_sleep_state.user_id AS user_id,
        current_sleep_state.started_at AS started_at,
        current_sleep_state.ended_at AS ended_at,
        current_sleep_state.duration_seconds AS duration_seconds
    FROM current_sleep_state
    INNER JOIN dirty_keys
        ON dirty_keys.user_id = current_sleep_state.user_id
        AND dirty_keys.sleep_id = current_sleep_state.sleep_id
    WHERE current_sleep_state.source_is_deleted = 1

    UNION ALL

    SELECT
        existing_sleep_state.sleep_id AS sleep_id,
        existing_sleep_state.user_id AS user_id,
        existing_sleep_state.started_at AS started_at,
        existing_sleep_state.ended_at AS ended_at,
        existing_sleep_state.duration_seconds AS duration_seconds
    FROM existing_sleep_state
    INNER JOIN dirty_keys
        ON dirty_keys.user_id = existing_sleep_state.user_id
        AND dirty_keys.sleep_id = existing_sleep_state.sleep_id
    LEFT JOIN current_sleep_state
        ON current_sleep_state.user_id = existing_sleep_state.user_id
        AND current_sleep_state.sleep_id = existing_sleep_state.sleep_id
    WHERE existing_sleep_state.is_deleted = 0
        AND current_sleep_state.sleep_id IS NULL
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9, 'UTC') AS refreshed_at
)

SELECT
    current_windows.sleep_id AS sleep_id,
    current_windows.user_id AS user_id,
    current_windows.started_at AS started_at,
    current_windows.ended_at AS ended_at,
    current_windows.duration_seconds AS duration_seconds,
    current_windows.eligible_sample_count AS eligible_sample_count,
    current_windows.source_changed_at AS source_changed_at,
    refresh_clock.refresh_version AS refresh_version,
    toUInt8(0) AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM current_windows
CROSS JOIN refresh_clock

UNION ALL

SELECT
    stale_windows.sleep_id AS sleep_id,
    stale_windows.user_id AS user_id,
    stale_windows.started_at AS started_at,
    stale_windows.ended_at AS ended_at,
    stale_windows.duration_seconds AS duration_seconds,
    toUInt64(0) AS eligible_sample_count,
    refresh_clock.refreshed_at AS source_changed_at,
    refresh_clock.refresh_version AS refresh_version,
    toUInt8(1) AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM stale_windows
CROSS JOIN refresh_clock
