import { cyclingPowerSchemaStatements } from "../cycling-power-schema.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0114_normalized_power_projection",
    statements: [
      ...cyclingPowerSchemaStatements(),
      "DROP VIEW IF EXISTS analytics.cycling_threshold_history",
      "DROP TABLE IF EXISTS analytics.cycling_power_history_rows",
    ],
  };
}
