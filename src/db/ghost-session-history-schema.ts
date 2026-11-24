export const createGhostSessionHistorySql = `CREATE TABLE IF NOT EXISTS analytics.ghost_session_history (
  user_id UUID,
  activity_id UUID,
  anchor_status LowCardinality(String),
  anchor_generation Nullable(String),
  history_generation Nullable(String),
  next_cursor Nullable(String),
  source_history_coverage LowCardinality(String),
  history_coverage LowCardinality(String),
  comparison_limited UInt8,
  refresh_version UInt64
) ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`;
