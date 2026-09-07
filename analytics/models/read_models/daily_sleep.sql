{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, date)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

WITH {% if is_incremental() %}
target_state AS (
    SELECT
        coalesce(
            max(refreshed_at),
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
        ) AS last_refreshed_at,
        count() = 0 AS is_empty
    FROM {{ this }}
),

current_rows AS (
    SELECT
        user_id,
        date,
        provider_id,
        source_name,
        source_providers,
        selected_session_id,
        overlapping_sessions,
        timezone,
        start_utc_offset_minutes,
        end_utc_offset_minutes,
        local_time_source,
        started_at,
        ended_at,
        duration_minutes,
        deep_minutes,
        rem_minutes,
        light_minutes,
        awake_minutes,
        efficiency_pct,
        staging_available,
        is_deleted
    FROM {{ this }} FINAL
),
{% endif %}
source_sleep AS (
    SELECT
        user_id,
        _peerdb_synced_at,
        _peerdb_is_deleted
    FROM {{ source('postgres_fitness', 'sleep_session') }} FINAL
),

changed_users AS (
    SELECT DISTINCT user_id
    FROM source_sleep
    WHERE
        {% if is_incremental() %}
            (SELECT is_empty FROM target_state)
            OR _peerdb_synced_at > (SELECT last_refreshed_at FROM target_state)
        {% else %}
            _peerdb_is_deleted = 0
        {% endif %}
),

live_sleep AS (
    SELECT
        sleep.id AS id,
        sleep.user_id AS user_id,
        toDate(sleep.started_at - INTERVAL 6 HOUR) AS date,
        sleep.provider_id AS provider_id,
        sleep.source_name AS source_name,
        sleep.source_providers AS source_providers,
        sleep.timezone AS timezone,
        sleep.start_utc_offset_minutes AS start_utc_offset_minutes,
        sleep.end_utc_offset_minutes AS end_utc_offset_minutes,
        sleep.local_time_source AS local_time_source,
        sleep.started_at AS started_at,
        sleep.ended_at AS ended_at,
        sleep.duration_minutes AS duration_minutes,
        sleep.deep_minutes AS deep_minutes,
        sleep.rem_minutes AS rem_minutes,
        sleep.light_minutes AS light_minutes,
        sleep.awake_minutes AS awake_minutes,
        sleep.efficiency_pct AS efficiency_pct,
        sleep.staging_available AS staging_available
    FROM {{ source('analytics', 'v_sleep') }} AS sleep
    INNER JOIN changed_users
        ON changed_users.user_id = sleep.user_id
    WHERE sleep.is_nap = false
),

{% if is_incremental() %}
dirty_dates AS (
    SELECT DISTINCT
        user_id,
        date
    FROM live_sleep
    UNION DISTINCT
    SELECT
        current_rows.user_id AS user_id,
        current_rows.date AS date
    FROM current_rows
    INNER JOIN changed_users
        ON changed_users.user_id = current_rows.user_id
    WHERE current_rows.is_deleted = 0
),
{% endif %}

ranked_sleep AS (
    SELECT
        live_sleep.id AS id,
        live_sleep.user_id AS user_id,
        live_sleep.date AS date,
        live_sleep.provider_id AS provider_id,
        live_sleep.source_name AS source_name,
        live_sleep.source_providers AS source_providers,
        live_sleep.timezone AS timezone,
        live_sleep.start_utc_offset_minutes AS start_utc_offset_minutes,
        live_sleep.end_utc_offset_minutes AS end_utc_offset_minutes,
        live_sleep.local_time_source AS local_time_source,
        live_sleep.started_at AS started_at,
        live_sleep.ended_at AS ended_at,
        live_sleep.duration_minutes AS duration_minutes,
        live_sleep.deep_minutes AS deep_minutes,
        live_sleep.rem_minutes AS rem_minutes,
        live_sleep.light_minutes AS light_minutes,
        live_sleep.awake_minutes AS awake_minutes,
        live_sleep.efficiency_pct AS efficiency_pct,
        live_sleep.staging_available AS staging_available,
        row_number() OVER (
            PARTITION BY live_sleep.user_id, live_sleep.date
            ORDER BY live_sleep.duration_minutes DESC NULLS LAST, live_sleep.started_at DESC
        ) AS row_number
    FROM live_sleep
),

nightly_winner AS (
    SELECT
        id,
        user_id,
        date,
        provider_id,
        source_name,
        source_providers,
        timezone,
        start_utc_offset_minutes,
        end_utc_offset_minutes,
        local_time_source,
        started_at,
        ended_at,
        duration_minutes,
        deep_minutes,
        rem_minutes,
        light_minutes,
        awake_minutes,
        efficiency_pct,
        staging_available
    FROM ranked_sleep
    WHERE row_number = 1
),

nightly_overlaps AS (
    SELECT
        nightly_winner.user_id AS user_id,
        nightly_winner.date AS date,
        arraySort(
            groupArray(CAST(
                (
                    candidate.id,
                    candidate.provider_id,
                    candidate.source_name,
                    candidate.source_providers,
                    candidate.timezone,
                    candidate.start_utc_offset_minutes,
                    candidate.end_utc_offset_minutes,
                    candidate.local_time_source,
                    candidate.started_at,
                    candidate.ended_at,
                    candidate.duration_minutes
                ),
                'Tuple(
                    session_id UUID,
                    provider_id String,
                    source_name Nullable(String),
                    source_providers Array(String),
                    timezone Nullable(String),
                    start_utc_offset_minutes Nullable(Int16),
                    end_utc_offset_minutes Nullable(Int16),
                    local_time_source String,
                    started_at DateTime64(6, ''UTC''),
                    ended_at Nullable(DateTime64(6, ''UTC'')),
                    duration_minutes Nullable(Int32)
                )'
            ))
        ) AS overlapping_sessions
    FROM nightly_winner
    INNER JOIN live_sleep AS candidate
        ON candidate.user_id = nightly_winner.user_id
        AND candidate.date = nightly_winner.date
        AND candidate.id != nightly_winner.id
        AND greatest(candidate.started_at, nightly_winner.started_at)
            < least(
                coalesce(candidate.ended_at, candidate.started_at + INTERVAL 8 HOUR),
                coalesce(nightly_winner.ended_at, nightly_winner.started_at + INTERVAL 8 HOUR)
            )
    GROUP BY
        nightly_winner.user_id,
        nightly_winner.date
),

selected_sleep AS (
    SELECT
        nightly_winner.*,
        nightly_winner.id AS selected_session_id,
        coalesce(
            nightly_overlaps.overlapping_sessions,
            CAST(
                [],
                'Array(Tuple(
                    session_id UUID,
                    provider_id String,
                    source_name Nullable(String),
                    source_providers Array(String),
                    timezone Nullable(String),
                    start_utc_offset_minutes Nullable(Int16),
                    end_utc_offset_minutes Nullable(Int16),
                    local_time_source String,
                    started_at DateTime64(6, ''UTC''),
                    ended_at Nullable(DateTime64(6, ''UTC'')),
                    duration_minutes Nullable(Int32)
                ))'
            )
        ) AS overlapping_sessions
    FROM nightly_winner
    LEFT JOIN nightly_overlaps
        ON nightly_overlaps.user_id = nightly_winner.user_id
        AND nightly_overlaps.date = nightly_winner.date
),

rows_to_write AS (
    {% if is_incremental() %}
    SELECT
        dirty_dates.user_id AS user_id,
        dirty_dates.date AS date,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.provider_id,
            selected_sleep.provider_id
        ) AS provider_id,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.source_name,
            selected_sleep.source_name
        ) AS source_name,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.source_providers,
            selected_sleep.source_providers
        ) AS source_providers,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.selected_session_id,
            selected_sleep.selected_session_id
        ) AS selected_session_id,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.overlapping_sessions,
            selected_sleep.overlapping_sessions
        ) AS overlapping_sessions,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.timezone,
            selected_sleep.timezone
        ) AS timezone,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.start_utc_offset_minutes,
            selected_sleep.start_utc_offset_minutes
        ) AS start_utc_offset_minutes,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.end_utc_offset_minutes,
            selected_sleep.end_utc_offset_minutes
        ) AS end_utc_offset_minutes,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.local_time_source,
            selected_sleep.local_time_source
        ) AS local_time_source,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.started_at,
            selected_sleep.started_at
        ) AS started_at,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.ended_at,
            selected_sleep.ended_at
        ) AS ended_at,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.duration_minutes,
            selected_sleep.duration_minutes
        ) AS duration_minutes,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.deep_minutes,
            selected_sleep.deep_minutes
        ) AS deep_minutes,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.rem_minutes,
            selected_sleep.rem_minutes
        ) AS rem_minutes,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.light_minutes,
            selected_sleep.light_minutes
        ) AS light_minutes,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.awake_minutes,
            selected_sleep.awake_minutes
        ) AS awake_minutes,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.efficiency_pct,
            selected_sleep.efficiency_pct
        ) AS efficiency_pct,
        if(
            selected_sleep.user_id IS NULL,
            current_rows.staging_available,
            selected_sleep.staging_available
        ) AS staging_available,
        if(selected_sleep.user_id IS NULL, 1, 0) AS is_deleted
    FROM dirty_dates
    LEFT JOIN selected_sleep
        ON selected_sleep.user_id = dirty_dates.user_id
        AND selected_sleep.date = dirty_dates.date
    LEFT JOIN current_rows
        ON current_rows.user_id = dirty_dates.user_id
        AND current_rows.date = dirty_dates.date
    {% else %}
    SELECT
        selected_sleep.user_id AS user_id,
        selected_sleep.date AS date,
        selected_sleep.provider_id AS provider_id,
        selected_sleep.source_name AS source_name,
        selected_sleep.source_providers AS source_providers,
        selected_sleep.selected_session_id AS selected_session_id,
        selected_sleep.overlapping_sessions AS overlapping_sessions,
        selected_sleep.timezone AS timezone,
        selected_sleep.start_utc_offset_minutes AS start_utc_offset_minutes,
        selected_sleep.end_utc_offset_minutes AS end_utc_offset_minutes,
        selected_sleep.local_time_source AS local_time_source,
        selected_sleep.started_at AS started_at,
        selected_sleep.ended_at AS ended_at,
        selected_sleep.duration_minutes AS duration_minutes,
        selected_sleep.deep_minutes AS deep_minutes,
        selected_sleep.rem_minutes AS rem_minutes,
        selected_sleep.light_minutes AS light_minutes,
        selected_sleep.awake_minutes AS awake_minutes,
        selected_sleep.efficiency_pct AS efficiency_pct,
        selected_sleep.staging_available AS staging_available,
        0 AS is_deleted
    FROM selected_sleep
    {% endif %}
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9, 'UTC') AS refreshed_at
)

SELECT
    CAST(rows_to_write.user_id, 'UUID') AS user_id,
    CAST(rows_to_write.date, 'Date') AS date,
    rows_to_write.provider_id AS provider_id,
    rows_to_write.source_name AS source_name,
    rows_to_write.source_providers AS source_providers,
    rows_to_write.selected_session_id AS selected_session_id,
    rows_to_write.overlapping_sessions AS overlapping_sessions,
    rows_to_write.timezone AS timezone,
    rows_to_write.start_utc_offset_minutes AS start_utc_offset_minutes,
    rows_to_write.end_utc_offset_minutes AS end_utc_offset_minutes,
    rows_to_write.local_time_source AS local_time_source,
    rows_to_write.started_at AS started_at,
    rows_to_write.ended_at AS ended_at,
    rows_to_write.duration_minutes AS duration_minutes,
    rows_to_write.deep_minutes AS deep_minutes,
    rows_to_write.rem_minutes AS rem_minutes,
    rows_to_write.light_minutes AS light_minutes,
    rows_to_write.awake_minutes AS awake_minutes,
    rows_to_write.efficiency_pct AS efficiency_pct,
    rows_to_write.staging_available AS staging_available,
    refresh_clock.refresh_version AS refresh_version,
    rows_to_write.is_deleted AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM rows_to_write
CROSS JOIN refresh_clock
