import {
  METRIC_STREAM_PROVIDER_GENERATION_PROJECTION,
  METRIC_STREAM_TABLE,
  metricStreamProviderGenerationProjectionDefinition,
} from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0047_cover_provider_generation_projection",
    statements: [
      `ALTER TABLE ${METRIC_STREAM_TABLE}
        DROP PROJECTION IF EXISTS ${METRIC_STREAM_PROVIDER_GENERATION_PROJECTION}`,
      `ALTER TABLE ${METRIC_STREAM_TABLE}
        ADD PROJECTION IF NOT EXISTS ${METRIC_STREAM_PROVIDER_GENERATION_PROJECTION} (
          ${metricStreamProviderGenerationProjectionDefinition()}
        )`,
    ],
  };
}
