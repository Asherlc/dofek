{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, sleep_id, recorded_date, recorded_at)',
    full_refresh=false,
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1,
        'enable_materialized_cte': 1
    }
) }}

{% set sleep_dirty_key_batch_size = var('sleep_dirty_key_batch_size', 32) %}

WITH
current_windows AS materialized (
    SELECT
        sleep_id,
        user_id,
        started_at,
        ended_at,
        duration_seconds,
        eligible_sample_count,
        is_deleted,
        refreshed_at
    FROM {{ ref('sleep_heart_rate_window') }} FINAL
),

activity_source AS materialized (
    SELECT
        id,
        user_id,
        started_at,
        coalesce(ended_at, started_at + INTERVAL 12 HOUR) AS ended_at,
        _peerdb_is_deleted,
        provider_absent_at,
        deleted_at
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
),

existing_sleep_state AS materialized (
    {% if is_incremental() %}
        SELECT
            user_id,
            sleep_id,
            max(refreshed_at) AS refreshed_at,
            countIf(is_deleted = 0) > 0 AS has_active_samples
        FROM {{ this }} FINAL
        WHERE (user_id, sleep_id) IN (
            SELECT
                user_id,
                sleep_id
            FROM current_windows
        )
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
        current_windows.user_id AS user_id,
        current_windows.sleep_id AS sleep_id,
        current_windows.refreshed_at AS source_changed_at
    FROM current_windows
    LEFT JOIN existing_sleep_state
        ON existing_sleep_state.user_id = current_windows.user_id
        AND existing_sleep_state.sleep_id = current_windows.sleep_id
    WHERE current_windows.is_deleted = 0
        AND current_windows.eligible_sample_count > 0
        AND (
            existing_sleep_state.sleep_id IS NULL
            OR current_windows.refreshed_at > existing_sleep_state.refreshed_at
        )
),

stale_sleep_dirty_keys AS (
    SELECT
        existing_sleep_state.user_id AS user_id,
        existing_sleep_state.sleep_id AS sleep_id,
        current_windows.refreshed_at AS source_changed_at
    FROM existing_sleep_state
    INNER JOIN current_windows
        ON current_windows.user_id = existing_sleep_state.user_id
        AND current_windows.sleep_id = existing_sleep_state.sleep_id
    WHERE existing_sleep_state.has_active_samples
        AND (
            current_windows.is_deleted = 1
            OR current_windows.eligible_sample_count = 0
        )
        AND current_windows.refreshed_at > existing_sleep_state.refreshed_at
),

dirty_keys AS materialized (
    SELECT
        user_id,
        sleep_id
    FROM (
        SELECT
            user_id,
            sleep_id,
            source_changed_at
        FROM source_dirty_sleep_keys
        UNION ALL
        SELECT
            user_id,
            sleep_id,
            source_changed_at
        FROM stale_sleep_dirty_keys
    )
    ORDER BY
        source_changed_at,
        user_id,
        sleep_id
    LIMIT {{ sleep_dirty_key_batch_size }}
),

active_dirty_sleep AS materialized (
    SELECT
        current_windows.sleep_id AS sleep_id,
        current_windows.user_id AS user_id,
        current_windows.started_at AS started_at,
        current_windows.ended_at AS ended_at,
        current_windows.duration_seconds AS duration_seconds,
        current_windows.refreshed_at AS source_refreshed_at
    FROM current_windows
    INNER JOIN dirty_keys
        ON dirty_keys.user_id = current_windows.user_id
        AND dirty_keys.sleep_id = current_windows.sleep_id
    WHERE current_windows.is_deleted = 0
        AND current_windows.eligible_sample_count > 0
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
        greatest(samples.refreshed_at, active_dirty_sleep.source_refreshed_at)
            AS source_refreshed_at
    FROM {{ ref('deduped_sensor') }} AS samples FINAL
    INNER JOIN dirty_sleep_dates
        ON dirty_sleep_dates.user_id = samples.user_id
        AND dirty_sleep_dates.recorded_date = samples.recorded_date
    INNER JOIN active_dirty_sleep
        ON active_dirty_sleep.user_id = samples.user_id
        AND samples.recorded_at >= active_dirty_sleep.started_at
        AND samples.recorded_at <= active_dirty_sleep.ended_at
    LEFT JOIN activity_source AS overlapping_activity
        ON overlapping_activity.user_id = active_dirty_sleep.user_id
        AND overlapping_activity.started_at <= samples.recorded_at
        AND overlapping_activity.ended_at >= samples.recorded_at
        AND overlapping_activity._peerdb_is_deleted = 0
        AND overlapping_activity.provider_absent_at IS NULL
        AND overlapping_activity.deleted_at IS NULL
    WHERE samples.channel = 'heart_rate'
        AND samples.is_deleted = 0
        AND samples.scalar IS NOT NULL
        AND overlapping_activity.id IS NULL
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
    is_stale AS is_deleted,
    if(is_stale, refresh_clock.refreshed_at, source_refreshed_at) AS refreshed_at
FROM merged_samples
CROSS JOIN refresh_clock
