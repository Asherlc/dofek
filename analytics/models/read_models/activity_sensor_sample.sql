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
    on_schema_change='append_new_columns',
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
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

WITH batch_samples AS MATERIALIZED (
    SELECT *
    FROM {{ ref('deduped_sensor') }}
),

batch_sample_keys AS MATERIALIZED (
    SELECT DISTINCT
        user_id,
        channel,
        recorded_at
    FROM batch_samples
),

activity_group_state AS (
    SELECT
        deduped.activity_id AS group_activity_id,
        deduped.user_id AS user_id,
        deduped.started_at AS started_at,
        deduped.ended_at AS ended_at,
        greatest(
            coalesce(deduped.ended_at, deduped.started_at + INTERVAL 12 HOUR),
            deduped.started_at
        ) AS effective_ended_at,
        deduped.source_synced_at AS source_synced_at,
        deduped.member_activity_ids AS member_activity_ids,
        deduped.is_deleted AS is_deleted,
        deduped.refreshed_at AS refreshed_at
    FROM {{ ref('deduped_activities') }} AS deduped FINAL
    WHERE 1 = 1
        {% if activity_refresh_scoped %}
        AND deduped.user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND (
            deduped.activity_id IN {{ activity_refresh_ids() }}
            OR hasAny(deduped.member_activity_ids, {{ activity_refresh_ids() }})
        )
        {% endif %}
),

current_activity AS (
    SELECT
        activity_group_state.group_activity_id AS activity_id,
        activity_group_state.user_id,
        activity_group_state.started_at,
        activity_group_state.ended_at,
        activity_group_state.effective_ended_at,
        activity_group_state.source_synced_at,
        activity_group_state.member_activity_ids
    FROM activity_group_state
    WHERE activity_group_state.is_deleted = 0
),

activity_days AS (
    SELECT
        activity_id,
        user_id,
        started_at,
        ended_at,
        effective_ended_at,
        source_synced_at,
        member_activity_ids,
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
        samples.provider_id AS provider_id,
        samples.member_activity_id AS member_activity_id,
        samples.device_id AS device_id,
        samples.source_external_id AS source_external_id,
        samples.source_type AS source_type,
        samples.source_metric_stream_id AS source_metric_stream_id,
        samples.measurement_kind AS measurement_kind,
        samples.is_deleted AS is_deleted,
        greatest(samples.refreshed_at, activity_days.source_synced_at) AS source_refreshed_at
    FROM batch_samples AS samples
    INNER JOIN activity_days
        ON activity_days.user_id = samples.user_id
        AND activity_days.recorded_date = samples.recorded_date
        AND samples.recorded_at >= activity_days.started_at
        AND samples.recorded_at <= activity_days.effective_ended_at
        AND (
            samples.source_activity_id IS null
            OR has(activity_days.member_activity_ids, assumeNotNull(samples.source_activity_id))
        )
    WHERE samples.is_deleted = 0
),

{% if is_incremental() %}
existing_activity_samples AS (
    SELECT existing_samples.*
    FROM {{ this }} AS existing_samples FINAL
    INNER JOIN batch_sample_keys
        ON batch_sample_keys.user_id = existing_samples.user_id
        AND batch_sample_keys.channel = existing_samples.channel
        AND batch_sample_keys.recorded_at = existing_samples.recorded_at
    INNER JOIN activity_group_state
        ON activity_group_state.group_activity_id = existing_samples.activity_id
        AND activity_group_state.user_id = existing_samples.user_id
    WHERE existing_samples.is_deleted = 0
),

stale_activity_samples AS (
    SELECT
        existing_samples.activity_id AS stale_activity_id,
        existing_samples.user_id AS stale_user_id,
        existing_samples.recorded_at AS stale_recorded_at,
        existing_samples.recorded_date AS stale_recorded_date,
        existing_samples.channel AS stale_channel,
        existing_samples.scalar AS stale_scalar,
        existing_samples.provider_id AS stale_provider_id,
        existing_samples.member_activity_id AS stale_member_activity_id,
        existing_samples.device_id AS stale_device_id,
        existing_samples.source_external_id AS stale_source_external_id,
        existing_samples.source_type AS stale_source_type,
        existing_samples.source_metric_stream_id AS stale_source_metric_stream_id,
        existing_samples.measurement_kind AS stale_measurement_kind,
        greatest(existing_samples.refreshed_at, activity_group_state.refreshed_at) AS stale_refreshed_at
    FROM existing_activity_samples AS existing_samples
    INNER JOIN activity_group_state
        ON activity_group_state.group_activity_id = existing_samples.activity_id
        AND activity_group_state.user_id = existing_samples.user_id
    LEFT JOIN activity_samples
        ON activity_samples.activity_id = existing_samples.activity_id
        AND activity_samples.user_id = existing_samples.user_id
        AND activity_samples.recorded_at = existing_samples.recorded_at
        AND activity_samples.channel = existing_samples.channel
    WHERE activity_samples.activity_id IS null
)
{% endif %}

SELECT
    activity_samples.activity_id,
    activity_samples.user_id,
    activity_samples.recorded_at,
    activity_samples.recorded_date,
    activity_samples.channel,
    activity_samples.scalar,
    activity_samples.provider_id,
    activity_samples.member_activity_id,
    activity_samples.device_id,
    activity_samples.source_external_id,
    activity_samples.source_type,
    activity_samples.source_metric_stream_id,
    activity_samples.measurement_kind,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    activity_samples.is_deleted,
    activity_samples.source_refreshed_at AS refreshed_at
FROM activity_samples

{% if is_incremental() %}
UNION ALL

SELECT
    stale_activity_samples.stale_activity_id AS activity_id,
    stale_activity_samples.stale_user_id AS user_id,
    stale_activity_samples.stale_recorded_at AS recorded_at,
    stale_activity_samples.stale_recorded_date AS recorded_date,
    stale_activity_samples.stale_channel AS channel,
    stale_activity_samples.stale_scalar AS scalar,
    stale_activity_samples.stale_provider_id AS provider_id,
    stale_activity_samples.stale_member_activity_id AS member_activity_id,
    stale_activity_samples.stale_device_id AS device_id,
    stale_activity_samples.stale_source_external_id AS source_external_id,
    stale_activity_samples.stale_source_type AS source_type,
    stale_activity_samples.stale_source_metric_stream_id AS source_metric_stream_id,
    stale_activity_samples.stale_measurement_kind AS measurement_kind,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    1 AS is_deleted,
    stale_activity_samples.stale_refreshed_at AS refreshed_at
FROM stale_activity_samples
{% endif %}
