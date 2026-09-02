import { buildMetricStreamDeleteAcknowledgementTableSql } from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0045_metric_stream_delete_acknowledgement",
    statements: [buildMetricStreamDeleteAcknowledgementTableSql()],
  };
}
