import { buildMetricStreamSinkSchemaStatements } from "../clickhouse-metric-stream-bootstrap.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return { id: "0112_metric_stream_journal", statements: buildMetricStreamSinkSchemaStatements() };
}
