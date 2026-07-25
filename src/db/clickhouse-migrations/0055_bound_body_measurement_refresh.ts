import { buildBodyMeasurementReadModelStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0055_bound_body_measurement_refresh",
    statements: buildBodyMeasurementReadModelStatements(),
  };
}
