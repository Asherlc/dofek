export const ghostTrackIndexColumns = `
  user_id UUID,
  activity_id UUID,
  gps_source_refreshed_at_ns Int64,
  gps_refresh_version UInt64,
  member_signature String,
  status LowCardinality(String),
  member_activity_id Nullable(UUID),
  provider_id Nullable(String),
  device_id Nullable(String),
  sport Nullable(String),
  modality Nullable(String),
  started_at Nullable(DateTime64(6, 'UTC')),
  ended_at Nullable(DateTime64(6, 'UTC')),
  min_lat Nullable(Float64),
  max_lat Nullable(Float64),
  min_lng Nullable(Float64),
  max_lng Nullable(Float64),
  point_count Nullable(UInt32),
  track_refresh_version Nullable(UInt64),
  track_source_refreshed_at_ns Nullable(Int64),
  member_source_synced_at_ns Nullable(Int64)
`;

export const createGhostTrackIndexSql = `CREATE TABLE IF NOT EXISTS analytics.ghost_track (
  ${ghostTrackIndexColumns},
  refresh_version UInt64
) ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`;
