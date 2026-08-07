import { buildPostgresFitnessRawTableStatements } from "../clickhouse-raw-tables.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0018_sensor_priority_raw_tables",
    statements: buildPostgresFitnessRawTableStatements(),
  };
}
