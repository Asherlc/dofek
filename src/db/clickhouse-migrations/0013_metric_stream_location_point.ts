import { rebuildMetricStreamLocationPoint } from "./custom-runs.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0013_metric_stream_location_point",
    statements: [],
    run: rebuildMetricStreamLocationPoint,
  };
}
