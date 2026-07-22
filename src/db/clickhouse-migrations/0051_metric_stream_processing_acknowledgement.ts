import { buildMetricStreamProcessingAcknowledgementTableSql } from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0051_metric_stream_processing_acknowledgement",
    statements: [buildMetricStreamProcessingAcknowledgementTableSql()],
  };
}
