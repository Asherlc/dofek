import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0091_metric_stream_freshness_index",
    statements: [
      "ALTER TABLE ingest.metric_stream ADD INDEX IF NOT EXISTS ingested_at_minmax ingested_at TYPE minmax GRANULARITY 1",
      "ALTER TABLE ingest.metric_stream MATERIALIZE INDEX ingested_at_minmax SETTINGS mutations_sync = 2",
    ],
  };
}
