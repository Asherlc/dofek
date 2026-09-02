{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(activity_id, duplicate_activity_id)',
    query_settings={
        'max_threads': 1
    }
) }}

{% set activity_refresh_scoped = activity_refresh_scope_enabled() %}

WITH source_records AS (
    SELECT
        activity_id,
        provider_id,
        user_id,
        canonical_type,
        started_at,
        coalesce(ended_at, started_at + INTERVAL 12 HOUR) AS ended_at
    FROM {{ ref('activity_source_records') }} FINAL
    WHERE is_deleted = 0
),

tombstoned_records AS (
    SELECT
        activity.id AS activity_id,
        activity.user_id AS user_id,
        activity.provider_id AS provider_id,
        activity.canonical_type AS canonical_type,
        activity.started_at AS started_at,
        coalesce(activity.ended_at, activity.started_at + INTERVAL 12 HOUR) AS ended_at
    FROM {{ source('postgres_fitness', 'activity') }} AS activity FINAL
    WHERE activity._peerdb_is_deleted = 0
        AND activity.provider_absent_at IS NOT null
        AND activity.deleted_at IS null
),

active_duplicate_matches AS (
    SELECT
        left_activity.activity_id AS activity_id,
        right_activity.activity_id AS duplicate_activity_id,
        dateDiff(
            'second',
            greatest(left_activity.started_at, right_activity.started_at),
            least(left_activity.ended_at, right_activity.ended_at)
        ) / nullIf(dateDiff(
            'second',
            least(left_activity.started_at, right_activity.started_at),
            greatest(left_activity.ended_at, right_activity.ended_at)
        ), 0) AS overlap_ratio
    FROM source_records AS left_activity
    INNER JOIN source_records AS right_activity
        ON left_activity.user_id = right_activity.user_id
        AND toString(left_activity.activity_id) < toString(right_activity.activity_id)
        AND (
            left_activity.canonical_type = right_activity.canonical_type
            OR (
                left_activity.canonical_type = 'other'
                AND right_activity.canonical_type != 'other'
                AND left_activity.provider_id = right_activity.provider_id
                AND dateDiff('second', left_activity.started_at, left_activity.ended_at)
                    <= dateDiff('second', right_activity.started_at, right_activity.ended_at)
            )
            OR (
                right_activity.canonical_type = 'other'
                AND left_activity.canonical_type != 'other'
                AND right_activity.provider_id = left_activity.provider_id
                AND dateDiff('second', right_activity.started_at, right_activity.ended_at)
                    <= dateDiff('second', left_activity.started_at, left_activity.ended_at)
            )
        )
        AND (
            dateDiff(
                'second',
                greatest(left_activity.started_at, right_activity.started_at),
                least(left_activity.ended_at, right_activity.ended_at)
            ) / nullIf(dateDiff(
                'second',
                least(left_activity.started_at, right_activity.started_at),
                greatest(left_activity.ended_at, right_activity.ended_at)
            ), 0) > 0.8
            OR (
                left_activity.provider_id != right_activity.provider_id
                AND dateDiff('second', left_activity.started_at, left_activity.ended_at) > 0
                AND dateDiff('second', right_activity.started_at, right_activity.ended_at) > 0
                AND dateDiff(
                    'second',
                    greatest(left_activity.started_at, right_activity.started_at),
                    least(left_activity.ended_at, right_activity.ended_at)
                ) > 0
                AND dateDiff(
                    'second',
                    greatest(left_activity.started_at, right_activity.started_at),
                    least(left_activity.ended_at, right_activity.ended_at)
                ) / nullIf(least(
                    dateDiff('second', left_activity.started_at, left_activity.ended_at),
                    dateDiff('second', right_activity.started_at, right_activity.ended_at)
                ), 0) > 0.8
            )
        )
        {% if activity_refresh_scoped %}
        AND (
            left_activity.activity_id IN {{ activity_refresh_ids() }}
            OR right_activity.activity_id IN {{ activity_refresh_ids() }}
        )
        {% endif %}
),

active_to_tombstoned_matches AS (
    SELECT
        left_activity.activity_id AS activity_id,
        right_activity.activity_id AS duplicate_activity_id,
        dateDiff(
            'second',
            greatest(left_activity.started_at, right_activity.started_at),
            least(left_activity.ended_at, right_activity.ended_at)
        ) / nullIf(dateDiff(
            'second',
            least(left_activity.started_at, right_activity.started_at),
            greatest(left_activity.ended_at, right_activity.ended_at)
        ), 0) AS overlap_ratio
    FROM source_records AS left_activity
    INNER JOIN tombstoned_records AS right_activity
        ON left_activity.user_id = right_activity.user_id
        AND (
            left_activity.canonical_type = right_activity.canonical_type
            OR (
                left_activity.canonical_type = 'other'
                AND right_activity.canonical_type != 'other'
                AND left_activity.provider_id = right_activity.provider_id
                AND dateDiff('second', left_activity.started_at, left_activity.ended_at)
                    <= dateDiff('second', right_activity.started_at, right_activity.ended_at)
            )
            OR (
                right_activity.canonical_type = 'other'
                AND left_activity.canonical_type != 'other'
                AND right_activity.provider_id = left_activity.provider_id
                AND dateDiff('second', right_activity.started_at, right_activity.ended_at)
                    <= dateDiff('second', left_activity.started_at, left_activity.ended_at)
            )
        )
        AND (
            dateDiff(
                'second',
                greatest(left_activity.started_at, right_activity.started_at),
                least(left_activity.ended_at, right_activity.ended_at)
            ) / nullIf(dateDiff(
                'second',
                least(left_activity.started_at, right_activity.started_at),
                greatest(left_activity.ended_at, right_activity.ended_at)
            ), 0) > 0.8
            OR (
                left_activity.provider_id != right_activity.provider_id
                AND dateDiff('second', left_activity.started_at, left_activity.ended_at) > 0
                AND dateDiff('second', right_activity.started_at, right_activity.ended_at) > 0
                AND dateDiff(
                    'second',
                    greatest(left_activity.started_at, right_activity.started_at),
                    least(left_activity.ended_at, right_activity.ended_at)
                ) > 0
                AND dateDiff(
                    'second',
                    greatest(left_activity.started_at, right_activity.started_at),
                    least(left_activity.ended_at, right_activity.ended_at)
                ) / nullIf(least(
                    dateDiff('second', left_activity.started_at, left_activity.ended_at),
                    dateDiff('second', right_activity.started_at, right_activity.ended_at)
                ), 0) > 0.8
            )
        )
        {% if activity_refresh_scoped %}
        AND left_activity.activity_id IN {{ activity_refresh_ids() }}
        {% endif %}
),

current_duplicate_matches AS (
    SELECT
        activity_id,
        duplicate_activity_id,
        overlap_ratio
    FROM active_duplicate_matches

    UNION ALL

    SELECT
        activity_id,
        duplicate_activity_id,
        overlap_ratio
    FROM active_to_tombstoned_matches
),

existing_duplicate_matches AS (
    {% if is_incremental() %}
        SELECT
            activity_id,
            duplicate_activity_id
        FROM {{ this }} FINAL
        WHERE is_deleted = 0
            {% if activity_refresh_scoped %}
            AND (
                activity_id IN {{ activity_refresh_ids() }}
                OR duplicate_activity_id IN {{ activity_refresh_ids() }}
            )
            {% endif %}
    {% else %}
        SELECT
            CAST(null, 'Nullable(UUID)') AS activity_id,
            CAST(null, 'Nullable(UUID)') AS duplicate_activity_id
        WHERE 1 = 0
    {% endif %}
),

stale_duplicate_matches AS (
    SELECT
        existing_duplicate_matches.activity_id,
        existing_duplicate_matches.duplicate_activity_id
    FROM existing_duplicate_matches
    LEFT ANTI JOIN current_duplicate_matches
        ON current_duplicate_matches.activity_id = existing_duplicate_matches.activity_id
        AND current_duplicate_matches.duplicate_activity_id = existing_duplicate_matches.duplicate_activity_id
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    activity_id,
    duplicate_activity_id,
    overlap_ratio,
    refresh_clock.refresh_version AS refresh_version,
    0 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM current_duplicate_matches
CROSS JOIN refresh_clock

UNION ALL

SELECT
    assumeNotNull(activity_id) AS activity_id,
    assumeNotNull(duplicate_activity_id) AS duplicate_activity_id,
    CAST(null, 'Nullable(Float64)') AS overlap_ratio,
    refresh_clock.refresh_version AS refresh_version,
    1 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM stale_duplicate_matches
CROSS JOIN refresh_clock
