import { buildBodyMeasurementSampleProjectionStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0050_repair_body_measurement_sample_ingest",
    statements: [
      "DROP VIEW IF EXISTS analytics.body_measurement_sample_ingest",
      ...buildBodyMeasurementSampleProjectionStatements(),
    ],
  };
}
