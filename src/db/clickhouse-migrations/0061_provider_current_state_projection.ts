import {
  METRIC_STREAM_PROVIDER_CURRENT_STATE_PROJECTION,
  METRIC_STREAM_TABLE,
  metricStreamProviderCurrentStateProjectionDefinition,
} from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0061_provider_current_state_projection",
    statements: [
      `ALTER TABLE ${METRIC_STREAM_TABLE}
        ADD PROJECTION IF NOT EXISTS ${METRIC_STREAM_PROVIDER_CURRENT_STATE_PROJECTION} (
          ${metricStreamProviderCurrentStateProjectionDefinition()}
        )`,
    ],
  };
}
