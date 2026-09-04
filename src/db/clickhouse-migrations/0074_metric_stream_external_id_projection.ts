import {
  METRIC_STREAM_PROVIDER_EXTERNAL_ID_PROJECTION,
  METRIC_STREAM_TABLE,
  metricStreamProviderExternalIdProjectionDefinition,
} from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0074_metric_stream_external_id_projection",
    statements: [
      `ALTER TABLE ${METRIC_STREAM_TABLE}
        ADD PROJECTION IF NOT EXISTS ${METRIC_STREAM_PROVIDER_EXTERNAL_ID_PROJECTION} (
          ${metricStreamProviderExternalIdProjectionDefinition()}
        )`,
    ],
  };
}
