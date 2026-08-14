import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0016_reduce_metric_stream_refresh_load",
    statements: [],
  };
}
