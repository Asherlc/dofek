import {
  METRIC_STREAM_PROVIDER_LIVE_GENERATION_PROJECTION,
  METRIC_STREAM_TABLE,
  metricStreamProviderLiveGenerationProjectionDefinition,
} from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0048_provider_live_generation_projection",
    statements: [
      `ALTER TABLE ${METRIC_STREAM_TABLE}
        ADD PROJECTION IF NOT EXISTS ${METRIC_STREAM_PROVIDER_LIVE_GENERATION_PROJECTION} (
          ${metricStreamProviderLiveGenerationProjectionDefinition()}
        )`,
    ],
  };
}
