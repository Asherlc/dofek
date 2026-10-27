import { buildPostgresFitnessRawTableStatements } from "../clickhouse-raw-tables.ts";
import type { ClickHouseMigration } from "./types.ts";

const tablePrefix =
  "CREATE TABLE IF NOT EXISTS postgres_fitness.processing_flow_marker_sensor_priority (";

export function createMigration(): ClickHouseMigration {
  const statement = buildPostgresFitnessRawTableStatements().find((candidate) =>
    candidate.startsWith(tablePrefix),
  );
  if (!statement) {
    throw new Error(`Missing ClickHouse processing marker definition: ${tablePrefix}`);
  }
  return {
    id: "0088_sensor_priority_processing_marker",
    phase: "pre-cdc",
    statements: [statement],
  };
}
