import { buildBodyMeasurementReadModelStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0044_materialize_body_measurement_view",
    statements: buildBodyMeasurementReadModelStatements(),
  };
}
