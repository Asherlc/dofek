-- depends_on: {{ source('analytics', 'cycling_power_history_rows') }}
-- depends_on: {{ source('analytics', 'cycling_power_observation_rows') }}

WITH expanded_history AS (
    SELECT
        user_id,
        model_version,
        refresh_version,
        refreshed_at,
        arrayJoin(events) AS event
    FROM {{ source('analytics', 'cycling_power_history_rows') }} FINAL
),

observation_state AS (
    SELECT
        user_id,
        max(refresh_version) AS observation_version
    FROM {{ source('analytics', 'cycling_power_observation_rows') }} FINAL
    GROUP BY user_id
)

SELECT
    history.user_id AS user_id,
    fromUnixTimestamp64Micro(toInt64(tupleElement(history.event, 'event_at') * 1000000), 'UTC') AS event_at,
    toUUIDOrNull(tupleElement(history.event, 'activity_id')) AS activity_id,
    tupleElement(history.event, 'eftp') AS eftp,
    toUUIDOrNull(tupleElement(history.event, 'evidence_activity_id')) AS evidence_activity_id,
    if(tupleElement(history.event, 'evidence_activity_id') IS NULL, CAST(NULL, 'Nullable(DateTime64(6, \'UTC\'))'),
        fromUnixTimestamp64Micro(toInt64(tupleElement(history.event, 'evidence_at') * 1000000), 'UTC')) AS evidence_at,
    if(tupleElement(history.event, 'evidence_activity_id') IS NULL, CAST(NULL, 'Nullable(UInt32)'), toUInt32(tupleElement(history.event, 'evidence_duration_seconds'))) AS evidence_duration_seconds,
    if(tupleElement(history.event, 'evidence_activity_id') IS NULL, CAST(NULL, 'Nullable(Float64)'), tupleElement(history.event, 'evidence_power')) AS evidence_power,
    history.model_version AS model_version
FROM expanded_history AS history
LEFT JOIN observation_state ON observation_state.user_id = history.user_id
WHERE history.refresh_version >= coalesce(observation_state.observation_version, 0)
