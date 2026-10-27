{{ config(materialized='view') }}
{% set target_user_ids = '{target_user_ids:Array(UUID)}' %}
{% set target_activity_keys = '{target_activity_keys:Array(Tuple(UUID, UUID))}' %}

WITH requested_input AS (
    SELECT {{ target_activity_keys }} AS requested_keys
),

requested AS (
    SELECT
        key.1 AS user_id,
        key.2 AS activity_id
    FROM requested_input
    ARRAY JOIN requested_keys AS key
    WHERE user_id IN {{ target_user_ids }}
),

pace_state AS (
    {{ activity_sensor_key_state('speed', ref('activity_pace_curve'), read_prior_state=true, required_durations=activity_pace_durations(), target_user_ids=target_user_ids, target_activity_keys=target_activity_keys) }}
),

heart_rate_state AS (
    {{ activity_sensor_key_state('heart_rate', ref('activity_heart_rate_distribution'), read_prior_state=true, target_user_ids=target_user_ids, target_activity_keys=target_activity_keys) }}
),

states AS (
    SELECT
        'activity_pace_curve' AS model,
        user_id,
        activity_id,
        canonical_type,
        started_at,
        ended_at,
        current_present,
        prior_present,
        prior_canonical_type,
        prior_started_at,
        prior_ended_at,
        source_activity_version,
        source_sensor_version,
        source_is_deleted,
        prior_activity_version,
        prior_sensor_version,
        prior_is_deleted,
        prior_refresh_version,
        prior_marker_complete,
        marker_count,
        marker_durations,
        marker_coherent,
        invalid_durations,
        is_dirty
    FROM pace_state
    UNION ALL
    SELECT
        'activity_heart_rate_distribution' AS model,
        user_id,
        activity_id,
        canonical_type,
        started_at,
        ended_at,
        current_present,
        prior_present,
        prior_canonical_type,
        prior_started_at,
        prior_ended_at,
        source_activity_version,
        source_sensor_version,
        source_is_deleted,
        prior_activity_version,
        prior_sensor_version,
        prior_is_deleted,
        prior_refresh_version,
        prior_marker_complete,
        marker_count,
        marker_durations,
        marker_coherent,
        invalid_durations,
        is_dirty
    FROM heart_rate_state
),

models AS (
    SELECT arrayJoin(['activity_pace_curve', 'activity_heart_rate_distribution']) AS model
)

SELECT
    requested.user_id AS user_id,
    requested.activity_id AS activity_id,
    models.model AS model,
    toUInt8(coalesce(states.current_present, 0)) AS current_present,
    toUInt8(coalesce(states.prior_present, 0)) AS prior_present,
    toString(states.source_activity_version) AS source_activity_version,
    if(states.activity_id IS null, CAST(null, 'Nullable(String)'), toString(states.source_sensor_version)) AS source_sensor_version,
    states.canonical_type AS canonical_type,
    toString(states.started_at) AS started_at,
    toString(states.ended_at) AS ended_at,
    states.source_is_deleted AS source_is_deleted,
    if(states.activity_id IS null, CAST(null, 'Nullable(UInt8)'),
        toUInt8(states.source_is_deleted = 1 OR states.canonical_type NOT IN ('cycling', 'running', 'swimming', 'walking', 'hiking'))
    ) AS expected_is_deleted,
    toString(states.prior_activity_version) AS prior_activity_version,
    toString(states.prior_sensor_version) AS prior_sensor_version,
    toString(states.prior_refresh_version) AS prior_refresh_version,
    states.prior_canonical_type AS prior_canonical_type,
    toString(states.prior_started_at) AS prior_started_at,
    toString(states.prior_ended_at) AS prior_ended_at,
    states.prior_is_deleted AS prior_is_deleted,
    toString(coalesce(states.marker_count, toUInt64(0))) AS marker_count,
    coalesce(states.marker_durations, CAST([], 'Array(UInt32)')) AS marker_durations,
    toUInt8(coalesce(states.marker_coherent, 0)) AS marker_coherent,
    toUInt8(coalesce(
        states.prior_marker_complete = 1 AND states.marker_coherent = 1
        AND states.marker_count = if(models.model = 'activity_pace_curve', {{ activity_pace_durations() | length }}, 1)
        AND states.prior_activity_version = states.source_activity_version
        AND states.prior_sensor_version = states.source_sensor_version
        AND states.prior_canonical_type = states.canonical_type
        AND states.prior_started_at = states.started_at
        AND states.prior_ended_at = states.ended_at
        AND states.prior_is_deleted = expected_is_deleted,
        0
    )) AS marker_complete,
    coalesce(states.invalid_durations, CAST([], 'Array(UInt32)')) AS invalid_durations,
    toUInt8(coalesce(states.is_dirty, 0)) AS is_dirty
FROM requested
CROSS JOIN models
LEFT JOIN states ON states.user_id = requested.user_id
    AND states.activity_id = requested.activity_id AND states.model = models.model
SETTINGS max_threads = 1, join_use_nulls = 1, enable_materialized_cte = 1
