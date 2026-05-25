import { replaceNativeMetricStreamAndBackfill } from "./custom-runs.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0006_backfill_native_metric_stream",
    statements: [],
    run: replaceNativeMetricStreamAndBackfill,
  };
}
