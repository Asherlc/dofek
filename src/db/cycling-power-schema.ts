/** Application persistence; numerical algorithms live in @dofek/cycling-power. */
export function buildCyclingPowerObservationRowsTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS analytics.cycling_power_observation_rows (
      user_id UUID,
      activity_id UUID,
      normalized_power Nullable(Float64),
      source_refresh_version UInt64,
      model_version String,
      is_deleted UInt8,
      refresh_version UInt64,
      refreshed_at DateTime64(6, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id)`;
}

export function cyclingPowerSchemaStatements(): string[] {
  return [
    buildCyclingPowerObservationRowsTableSql(),
    `CREATE TABLE IF NOT EXISTS analytics.cycling_power_history_rows (
      user_id UUID,
      source_refresh_version UInt64,
      as_of_day Date,
      model_version String,
      events Array(Tuple(
        event_at Float64,
        activity_id String,
        eftp Nullable(Float64),
        intensity_factor Nullable(Float64),
        power_tss Nullable(Float64),
        evidence_activity_id String,
        evidence_at Float64,
        evidence_duration_seconds Float64,
        evidence_power Float64
      )),
      refresh_version UInt64,
      refreshed_at DateTime64(6, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY user_id`,
    `CREATE OR REPLACE VIEW analytics.cycling_threshold_history AS
      SELECT history.user_id AS user_id,
        fromUnixTimestamp64Micro(toInt64(event.event_at * 1000000), 'UTC') AS event_at,
        toUUIDOrNull(nullIf(event.activity_id, '')) AS activity_id,
        event.eftp AS eftp,
        toUUIDOrNull(nullIf(event.evidence_activity_id, '')) AS evidence_activity_id,
        if(event.evidence_activity_id = '', CAST(NULL AS Nullable(DateTime64(6, 'UTC'))),
          fromUnixTimestamp64Micro(toInt64(event.evidence_at * 1000000), 'UTC')) AS evidence_at,
        if(event.evidence_activity_id = '', CAST(NULL, 'Nullable(UInt32)'), toUInt32(event.evidence_duration_seconds)) AS evidence_duration_seconds,
        if(event.evidence_activity_id = '', CAST(NULL, 'Nullable(Float64)'), event.evidence_power) AS evidence_power,
        history.model_version AS model_version
      FROM analytics.cycling_power_history_rows AS history FINAL
      LEFT JOIN (
        SELECT user_id, max(refresh_version) AS observation_version
        FROM analytics.cycling_power_observation_rows FINAL GROUP BY user_id
      ) AS observation_state ON observation_state.user_id = history.user_id
      ARRAY JOIN history.events AS event
      WHERE history.refresh_version >= coalesce(observation_state.observation_version, 0)`,
    `CREATE OR REPLACE VIEW analytics.cycling_activity_power_metrics AS
      SELECT history.user_id AS user_id, toUUID(event.activity_id) AS activity_id,
        fromUnixTimestamp64Micro(toInt64(event.event_at * 1000000), 'UTC') AS started_at,
        observations.normalized_power AS normalized_power,
        event.eftp AS eftp, event.intensity_factor AS intensity_factor, event.power_tss AS power_tss,
        toUUIDOrNull(nullIf(event.evidence_activity_id, '')) AS evidence_activity_id,
        if(event.evidence_activity_id = '', CAST(NULL AS Nullable(DateTime64(6, 'UTC'))),
          fromUnixTimestamp64Micro(toInt64(event.evidence_at * 1000000), 'UTC')) AS evidence_at,
        if(event.evidence_activity_id = '', CAST(NULL, 'Nullable(UInt32)'), toUInt32(event.evidence_duration_seconds)) AS evidence_duration_seconds,
        if(event.evidence_activity_id = '', CAST(NULL, 'Nullable(Float64)'), event.evidence_power) AS evidence_power,
        history.model_version AS model_version
      FROM analytics.cycling_power_history_rows AS history FINAL
      LEFT JOIN (
        SELECT user_id, max(refresh_version) AS observation_version
        FROM analytics.cycling_power_observation_rows FINAL GROUP BY user_id
      ) AS observation_state ON observation_state.user_id = history.user_id
      ARRAY JOIN history.events AS event
      LEFT JOIN (SELECT * FROM analytics.cycling_power_observation_rows FINAL WHERE is_deleted = 0) AS observations
        ON observations.user_id = history.user_id AND toString(observations.activity_id) = event.activity_id
      WHERE event.activity_id != ''
        AND history.refresh_version >= coalesce(observation_state.observation_version, 0)
      SETTINGS join_use_nulls = 1`,
  ];
}
