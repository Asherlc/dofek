{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1,
        'enable_materialized_cte': 1
    }
) }}

WITH fit_sessions AS MATERIALIZED (
    SELECT
        user_id,
        activity_id AS member_activity_id,
        started_at,
        ended_at,
        coalesce(toUInt64(toUnixTimestamp64Nano(source_synced_at)), toUInt64(0)) AS member_source_version,
        parseDateTime64BestEffortOrNull(
            JSONExtractString(coalesce(raw, ''), 'session', 'start_time'), 6, 'UTC'
        ) AS session_start,
        JSONExtract(coalesce(raw, ''), 'session', 'total_elapsed_time', 'Nullable(Float64)') AS elapsed_seconds,
        coalesce(
            session_start = started_at
            AND ended_at > started_at
            AND toUnixTimestamp64Micro(started_at) % 1000000 = 0
            AND toUnixTimestamp64Micro(ended_at) % 1000000 = 0
            AND elapsed_seconds = dateDiff('second', started_at, ended_at),
            false
        ) AS has_valid_bounds
    FROM {{ ref('activity_source_records') }} FINAL
    WHERE provider_id = 'fit-file' AND is_deleted = 0
),

fit_memberships AS MATERIALIZED (
    SELECT
        user_id,
        activity_id,
        member_activity_id
    FROM {{ ref('deduped_activity_members') }} FINAL
    WHERE is_deleted = 0
        AND (user_id, member_activity_id) IN (
            SELECT
                user_id,
                member_activity_id
            FROM fit_sessions
        )
),

current_groups AS (
    SELECT
        user_id,
        activity_id,
        refresh_version,
        member_activity_ids
    FROM {{ ref('deduped_activities') }} FINAL
    WHERE is_deleted = 0
        AND (user_id, activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM fit_memberships
        )
),

current_fit AS MATERIALIZED (
    SELECT
        fit_memberships.user_id AS user_id,
        fit_memberships.activity_id AS activity_id,
        countIf(fit_sessions.has_valid_bounds) AS valid_members,
        argMaxIf(
            tuple(
                fit_sessions.member_activity_id,
                fit_sessions.started_at,
                fit_sessions.ended_at,
                fit_sessions.member_source_version
            ),
            tuple(fit_sessions.member_source_version, fit_sessions.member_activity_id),
            fit_sessions.has_valid_bounds
        ) AS selected_member,
        max(current_groups.refresh_version) AS source_activity_version
    FROM fit_memberships
    INNER JOIN fit_sessions
        ON fit_memberships.user_id = fit_sessions.user_id
        AND fit_memberships.member_activity_id = fit_sessions.member_activity_id
    INNER JOIN current_groups
        ON fit_memberships.user_id = current_groups.user_id AND fit_memberships.activity_id = current_groups.activity_id
    WHERE has(current_groups.member_activity_ids, fit_memberships.member_activity_id)
    GROUP BY fit_memberships.user_id, fit_memberships.activity_id
),

{% if is_incremental() %}
prior_fit AS MATERIALIZED (
    SELECT
        user_id,
        activity_id,
        member_activity_id,
        status,
        source_activity_version,
        source_member_version,
        source_sensor_version,
        refresh_version,
        is_deleted
    FROM {{ this }} FINAL
),
{% endif %}

candidate_keys AS MATERIALIZED (
    -- Keep prior live keys so removal of the last qualifying FIT member can retire them.
    SELECT
        user_id,
        activity_id
    FROM current_fit
    {% if is_incremental() %}
    UNION DISTINCT
    SELECT
        user_id,
        activity_id
    FROM prior_fit
    WHERE is_deleted = 0
    {% endif %}
),

sample_versions AS (
    -- The activity-keyed projection supplies this clock, including sample tombstones.
    SELECT
        user_id,
        activity_id,
        max(refresh_version) AS source_sensor_version
    FROM {{ ref('activity_sensor_sample') }}
    WHERE (user_id, activity_id) IN (
        SELECT
            user_id,
            activity_id
        FROM candidate_keys
    )
    GROUP BY user_id, activity_id
),

candidate_state AS (
    SELECT
        candidate_keys.user_id AS user_id,
        candidate_keys.activity_id AS activity_id,
        if(current_fit.valid_members = 1, current_fit.selected_member.1, null) AS member_activity_id,
        if(current_fit.valid_members = 1, current_fit.selected_member.2, null) AS started_at,
        if(current_fit.valid_members = 1, current_fit.selected_member.3, null) AS ended_at,
        coalesce(current_fit.valid_members, toUInt64(0)) AS valid_members,
        coalesce(current_fit.source_activity_version, toUInt64(0)) AS source_activity_version,
        if(current_fit.valid_members = 1, current_fit.selected_member.4, toUInt64(0)) AS source_member_version,
        coalesce(sample_versions.source_sensor_version, toUInt64(0)) AS source_sensor_version,
        toUInt8(current_fit.activity_id IS null) AS is_deleted
    FROM candidate_keys
    LEFT JOIN current_fit
        ON candidate_keys.user_id = current_fit.user_id AND candidate_keys.activity_id = current_fit.activity_id
    LEFT JOIN sample_versions
        ON candidate_keys.user_id = sample_versions.user_id AND candidate_keys.activity_id = sample_versions.activity_id
),

dirty_fit AS MATERIALIZED (
    SELECT
        candidate_state.user_id AS user_id,
        candidate_state.activity_id AS activity_id,
        candidate_state.member_activity_id AS member_activity_id,
        candidate_state.started_at AS started_at,
        candidate_state.ended_at AS ended_at,
        candidate_state.valid_members AS valid_members,
        candidate_state.source_activity_version AS source_activity_version,
        candidate_state.source_member_version AS source_member_version,
        candidate_state.source_sensor_version AS source_sensor_version,
        candidate_state.is_deleted AS is_deleted
    FROM candidate_state
    {% if is_incremental() %}
    LEFT JOIN prior_fit
        ON candidate_state.user_id = prior_fit.user_id AND candidate_state.activity_id = prior_fit.activity_id
    WHERE
        prior_fit.activity_id IS null
        OR candidate_state.is_deleted != prior_fit.is_deleted
        OR candidate_state.source_activity_version != prior_fit.source_activity_version
        OR candidate_state.source_member_version != prior_fit.source_member_version
        OR candidate_state.source_sensor_version != prior_fit.source_sensor_version
        OR coalesce(
            candidate_state.member_activity_id != prior_fit.member_activity_id,
            isNull(candidate_state.member_activity_id) != isNull(prior_fit.member_activity_id)
        )
        OR (prior_fit.status = 'ambiguous_members') != (candidate_state.valid_members > 1)
    {% endif %}
    ORDER BY
        {% if is_incremental() %}
        coalesce(prior_fit.refresh_version, candidate_state.source_activity_version),
        {% else %}
        candidate_state.source_activity_version,
        {% endif %}
        candidate_state.user_id,
        candidate_state.activity_id
    LIMIT 32
),

current_samples AS (
    SELECT
        user_id,
        activity_id,
        recorded_at,
        scalar,
        provider_id,
        member_activity_id,
        source_type,
        measurement_kind
    FROM {{ ref('activity_sensor_sample') }} FINAL
    PREWHERE channel = 'heart_rate'
        AND (user_id, activity_id) IN (
            SELECT
                user_id,
                activity_id
            FROM dirty_fit
            WHERE valid_members = 1
        )
    WHERE is_deleted = 0
),

fit_samples AS (
    SELECT
        dirty_fit.user_id AS user_id,
        dirty_fit.activity_id AS activity_id,
        current_samples.scalar AS bpm,
        coalesce(
            current_samples.provider_id = 'fit-file'
            AND current_samples.member_activity_id = dirty_fit.member_activity_id
            AND current_samples.source_type = 'file'
            AND coalesce(current_samples.measurement_kind, 'unknown') != 'estimated'
            AND toUnixTimestamp64Micro(current_samples.recorded_at) % 1000000 = 0
            AND isFinite(current_samples.scalar)
            AND current_samples.scalar > 0,
            false
        ) AS valid_sample
    FROM dirty_fit
    INNER JOIN current_samples
        ON dirty_fit.user_id = current_samples.user_id AND dirty_fit.activity_id = current_samples.activity_id
    WHERE current_samples.recorded_at >= dirty_fit.started_at
        AND current_samples.recorded_at < dirty_fit.ended_at
),

bpm_counts AS (
    SELECT
        user_id,
        activity_id,
        bpm,
        valid_sample,
        count() AS sample_count
    FROM fit_samples
    GROUP BY user_id, activity_id, bpm, valid_sample
),

coverage AS (
    SELECT
        user_id,
        activity_id,
        sum(sample_count) AS observed_rows,
        sumIf(sample_count, valid_sample) AS covered_seconds,
        arraySort(groupArrayIf(tuple(toFloat64(assumeNotNull(bpm)), sample_count), valid_sample)) AS bpm_seconds
    FROM bpm_counts
    GROUP BY user_id, activity_id
),

classified AS (
    SELECT
        dirty_fit.user_id AS user_id,
        dirty_fit.activity_id AS activity_id,
        dirty_fit.member_activity_id AS member_activity_id,
        dirty_fit.started_at AS started_at,
        dirty_fit.ended_at AS ended_at,
        dirty_fit.is_deleted AS is_deleted,
        dirty_fit.source_activity_version AS source_activity_version,
        dirty_fit.source_member_version AS source_member_version,
        dirty_fit.source_sensor_version AS source_sensor_version,
        coalesce(coverage.covered_seconds, toUInt64(0)) AS covered_seconds,
        coalesce(coverage.bpm_seconds, []) AS bpm_seconds,
        multiIf(
            dirty_fit.is_deleted = 1, 'no_fit_member',
            dirty_fit.valid_members > 1, 'ambiguous_members',
            dirty_fit.valid_members = 0, 'invalid_bounds',
            coverage.observed_rows = coverage.covered_seconds
            AND coverage.covered_seconds = dateDiff('second', dirty_fit.started_at, dirty_fit.ended_at), 'complete',
            'incomplete'
        ) AS status
    FROM dirty_fit
    LEFT JOIN coverage
        ON dirty_fit.user_id = coverage.user_id AND dirty_fit.activity_id = coverage.activity_id
)

SELECT
    user_id,
    activity_id,
    member_activity_id,
    started_at,
    ended_at,
    status,
    covered_seconds,
    if(status = 'complete', bpm_seconds, []) AS bpm_seconds,
    is_deleted,
    source_sensor_version,
    toUInt64(toUnixTimestamp64Nano(now64(9, 'UTC'))) AS refresh_version,
    source_activity_version,
    source_member_version
FROM classified
