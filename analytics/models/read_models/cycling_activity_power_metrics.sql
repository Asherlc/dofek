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
),

current_observations AS (
    SELECT * FROM {{ source('analytics', 'cycling_power_observation_rows') }} FINAL
    WHERE is_deleted = 0
)

SELECT
    history.user_id AS user_id,
    toUUID(assumeNotNull(tupleElement(history.event, 'activity_id'))) AS activity_id,
    fromUnixTimestamp64Micro(toInt64(tupleElement(history.event, 'event_at') * 1000000), 'UTC') AS started_at,
    observations.normalized_power AS normalized_power,
    tupleElement(history.event, 'eftp') AS eftp,
    tupleElement(history.event, 'intensity_factor') AS intensity_factor,
    tupleElement(history.event, 'power_tss') AS power_tss,
    toUUIDOrNull(tupleElement(history.event, 'evidence_activity_id')) AS evidence_activity_id,
    if(tupleElement(history.event, 'evidence_activity_id') IS NULL, CAST(NULL, 'Nullable(DateTime64(6, \'UTC\'))'),
        fromUnixTimestamp64Micro(toInt64(tupleElement(history.event, 'evidence_at') * 1000000), 'UTC')) AS evidence_at,
    if(tupleElement(history.event, 'evidence_activity_id') IS NULL, CAST(NULL, 'Nullable(UInt32)'), toUInt32(tupleElement(history.event, 'evidence_duration_seconds'))) AS evidence_duration_seconds,
    if(tupleElement(history.event, 'evidence_activity_id') IS NULL, CAST(NULL, 'Nullable(Float64)'), tupleElement(history.event, 'evidence_power')) AS evidence_power,
    history.model_version AS model_version,
    history.refreshed_at AS refreshed_at
FROM expanded_history AS history
LEFT JOIN observation_state ON observation_state.user_id = history.user_id
LEFT JOIN current_observations AS observations
    ON observations.user_id = history.user_id AND toString(observations.activity_id) = tupleElement(history.event, 'activity_id')
WHERE tupleElement(history.event, 'activity_id') IS NOT NULL
    AND history.refresh_version >= coalesce(observation_state.observation_version, 0)
SETTINGS join_use_nulls = 1
