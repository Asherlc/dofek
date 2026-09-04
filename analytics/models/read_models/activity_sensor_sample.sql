{% set default_microbatch_begin = run_started_at.strftime('%Y-%m-%d') %}
{% set activity_sensor_sample_begin = var('activity_sensor_sample_begin', default_microbatch_begin) %}
{% set activity_refresh_scoped = activity_refresh_scope_enabled() %}

{{ config(
    materialized='incremental',
    incremental_strategy='microbatch',
    unique_key=['activity_id', 'channel', 'recorded_at'],
    event_time='refreshed_at',
    begin=activity_sensor_sample_begin,
    batch_size='day',
    lookback=3,
    full_refresh=false,
    concurrent_batches=false,
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id, recorded_date, channel, recorded_at)',
    settings={
        'deduplicate_merge_projection_mode': 'rebuild',
        'lightweight_mutation_projection_mode': 'rebuild'
    },
    projections=[{
        'name': 'by_activity_source_refresh_version',
        'query': 'SELECT activity_id, user_id, max(refresh_version) AS source_refresh_version GROUP BY activity_id, user_id'
    }],
    query_settings={
        'max_threads': 1
    }
) }}

WITH current_activity AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        ended_at,
        greatest(
            coalesce(ended_at, started_at + INTERVAL 12 HOUR),
            started_at
        ) AS effective_ended_at,
        source_synced_at
    FROM {{ ref('deduped_activities') }} FINAL
    WHERE is_deleted = 0
        {% if activity_refresh_scoped %}
        AND user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND (
            activity_id IN {{ activity_refresh_ids() }}
            OR hasAny(member_activity_ids, {{ activity_refresh_ids() }})
        )
        {% endif %}
),

activity_days AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        ended_at,
        effective_ended_at,
        source_synced_at,
        arrayJoin(arrayMap(
            day_offset -> addDays(toDate(started_at), day_offset),
            range(toUInt64(dateDiff('day', started_at, effective_ended_at)) + 1)
        )) AS recorded_date
    FROM current_activity
),

activity_samples AS (
    SELECT
        activity_days.activity_id AS activity_id,
        samples.user_id AS user_id,
        samples.recorded_at AS recorded_at,
        samples.recorded_date AS recorded_date,
        samples.channel AS channel,
        samples.scalar AS scalar,
        samples.is_deleted AS is_deleted,
        greatest(samples.refreshed_at, activity_days.source_synced_at) AS source_refreshed_at
    FROM {{ ref('deduped_sensor') }} AS samples
    INNER JOIN activity_days
        ON activity_days.user_id = samples.user_id
        AND activity_days.recorded_date = samples.recorded_date
        AND samples.recorded_at >= activity_days.started_at
        AND samples.recorded_at <= activity_days.effective_ended_at
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
    source_refreshed_at AS refreshed_at
FROM activity_samples
