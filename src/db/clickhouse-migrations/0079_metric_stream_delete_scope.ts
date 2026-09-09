import { buildMetricStreamDeleteScopeTableSql } from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0079_metric_stream_delete_scope",
    statements: [buildMetricStreamDeleteScopeTableSql()],
  };
}
