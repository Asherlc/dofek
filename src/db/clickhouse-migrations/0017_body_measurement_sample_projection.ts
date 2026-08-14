import {
  buildBodyMeasurementSampleProjectionMigrationStatements,
  buildProviderStatsReadModelStatements,
} from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0017_body_measurement_sample_projection",
    statements: [
      ...buildBodyMeasurementSampleProjectionMigrationStatements(),
      ...buildProviderStatsReadModelStatements(),
    ],
  };
}
