import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0086_activity_location_member_change",
    statements: [
      `CREATE TABLE IF NOT EXISTS analytics.activity_location_member_change (
  member_activity_id UUID,
  user_id UUID,
  changed_at SimpleAggregateFunction(max, DateTime64(9, 'UTC')),
  has_live_sample SimpleAggregateFunction(max, UInt8)
)
ENGINE = AggregatingMergeTree
ORDER BY (user_id, member_activity_id)`,
      `CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_location_member_change_ingest
TO analytics.activity_location_member_change
AS
SELECT
  assumeNotNull(activity_id) AS member_activity_id,
  user_id,
  max(ingested_at) AS changed_at,
  max(toUInt8(is_deleted = 0 AND point IS NOT NULL)) AS has_live_sample
FROM ingest.metric_stream
WHERE activity_id IS NOT NULL
  AND channel = 'location'
  AND (point IS NOT NULL OR is_deleted = 1)
GROUP BY user_id, member_activity_id`,
      `INSERT INTO analytics.activity_location_member_change
  (member_activity_id, user_id, changed_at, has_live_sample)
SELECT
  assumeNotNull(activity_id) AS member_activity_id,
  user_id,
  max(ingested_at) AS changed_at,
  max(toUInt8(is_deleted = 0 AND point IS NOT NULL)) AS has_live_sample
FROM ingest.metric_stream
WHERE activity_id IS NOT NULL
  AND channel = 'location'
  AND (point IS NOT NULL OR is_deleted = 1)
GROUP BY user_id, member_activity_id`,
    ],
  };
}
