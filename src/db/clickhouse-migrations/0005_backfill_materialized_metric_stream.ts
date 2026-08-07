import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0005_backfill_materialized_metric_stream",
    statements: [],
  };
}
