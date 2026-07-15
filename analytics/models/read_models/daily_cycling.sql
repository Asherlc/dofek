{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, date)',
    query_settings={
        'max_threads': 1
    }
) }}

WITH cycling_state AS (
    SELECT *
    FROM {{ ref('cycling_activity') }} FINAL
),

target_state AS (
    SELECT
        coalesce(max(refreshed_at), toDateTime64('1970-01-01 00:00:00', 9, 'UTC')) AS last_refreshed_at,
        {% if is_incremental() %}(count() = 0){% else %}1{% endif %} AS is_empty
    FROM {% if is_incremental() %}{{ this }}{% else %}(SELECT CAST(null, 'Nullable(DateTime64(9, ''UTC''))') AS refreshed_at){% endif %}
),

dirty_activity AS (
    SELECT
        activity_id,
        user_id,
        toDate(started_at) AS date
    FROM cycling_state
    CROSS JOIN target_state
    WHERE target_state.is_empty OR cycling_state.refreshed_at > target_state.last_refreshed_at
),

{% if is_incremental() %}
existing_activity_dates AS (
    SELECT
        user_id,
        date,
        tupleElement(existing_activity, 1) AS activity_id
    FROM {{ this }} FINAL
    ARRAY JOIN activities AS existing_activity
),
{% endif %}

dirty_dates AS (
    SELECT
        user_id,
        date
    FROM dirty_activity
    {% if is_incremental() %}
    UNION DISTINCT
    SELECT
        existing.user_id,
        existing.date
    FROM existing_activity_dates AS existing
    INNER JOIN dirty_activity
        ON dirty_activity.user_id = existing.user_id
        AND dirty_activity.activity_id = existing.activity_id
    {% endif %}
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9, 'UTC') AS refreshed_at
),

active_rows AS (
    SELECT
        cycling.user_id AS user_id,
        toDate(cycling.started_at) AS date,
        groupArray(tuple(
            cycling.activity_id,
            cycling.started_at,
            cycling.elapsed_seconds / 60.0,
            assumeNotNull(cycling.average_heart_rate),
            assumeNotNull(cycling.max_heart_rate),
            cycling.average_power,
            cycling.power_samples,
            cycling.heart_rate_samples,
            cycling.normalized_power,
            cycling.activity_name
        )) AS activities,
        toUInt8(0) AS is_deleted,
        refresh_clock.refresh_version AS refresh_version,
        refresh_clock.refreshed_at AS refreshed_at
    FROM cycling_state AS cycling
    INNER JOIN dirty_dates
        ON dirty_dates.user_id = cycling.user_id
        AND dirty_dates.date = toDate(cycling.started_at)
    CROSS JOIN refresh_clock
    WHERE cycling.is_deleted = 0
        AND cycling.ended_at IS NOT null
        AND cycling.average_heart_rate IS NOT null
        AND cycling.max_heart_rate IS NOT null
        AND cycling.heart_rate_samples > 0
    GROUP BY
        cycling.user_id,
        toDate(cycling.started_at),
        refresh_clock.refresh_version,
        refresh_clock.refreshed_at
),

tombstone_dates AS (
    SELECT
        dirty_dates.user_id AS user_id,
        dirty_dates.date AS date,
        CAST([], 'Array(Tuple(UUID, DateTime64(6, ''UTC''), Float64, Float64, Float64, Nullable(Float64), UInt64, UInt64, Nullable(Float64), Nullable(String)))') AS activities,
        toUInt8(1) AS is_deleted,
        refresh_clock.refresh_version AS refresh_version,
        refresh_clock.refreshed_at AS refreshed_at
    FROM dirty_dates
    LEFT JOIN active_rows
        ON active_rows.user_id = dirty_dates.user_id
        AND active_rows.date = dirty_dates.date
    CROSS JOIN refresh_clock
    WHERE active_rows.user_id IS null
)

SELECT
    user_id,
    date,
    activities,
    is_deleted,
    refresh_version,
    refreshed_at
FROM active_rows
UNION ALL
SELECT
    user_id,
    date,
    activities,
    is_deleted,
    refresh_version,
    refreshed_at
FROM tombstone_dates
