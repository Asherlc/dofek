export const ghostSessionPageColumns = `
  user_id UUID,
  activity_id UUID,
  anchor_generation String,
  history_generation String,
  request_cursor String,
  next_cursor Nullable(String),
  anchor_stamp String,
  anchor_summary Nullable(String),
  source_history_coverage LowCardinality(String),
  history_coverage LowCardinality(String),
  bounded UInt8,
  matches Array(Tuple(
    section_id String,
    pass_id String,
    match_kind String,
    anchor_interval String,
    candidate_activity_id UUID,
    candidate_started_at DateTime64(6, 'UTC'),
    candidate_pass_started_at_ms Float64,
    candidate_pass_ended_at_ms Float64,
    candidate_elapsed_ms Float64,
    candidate_stamp String,
    scalar_proof String,
    comparison String
  )),
  payload_digest String
`;

export const createGhostSessionPageSql = `CREATE TABLE IF NOT EXISTS analytics.ghost_session_page (
  ${ghostSessionPageColumns},
  refresh_version UInt64
) ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id, anchor_generation, history_generation, request_cursor)`;
