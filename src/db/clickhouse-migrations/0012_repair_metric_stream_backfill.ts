import { repairNativeMetricStreamBackfill } from "./custom-runs.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0012_repair_metric_stream_backfill",
    requiresPreviouslyAppliedMigrationId: "0006_backfill_native_metric_stream",
    statements: [],
    run: repairNativeMetricStreamBackfill,
  };
}
