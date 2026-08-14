import { replaceLegacyMetricStreamIfNeeded } from "./custom-runs.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0007_repair_legacy_metric_stream_engine",
    statements: [],
    run: replaceLegacyMetricStreamIfNeeded,
  };
}
