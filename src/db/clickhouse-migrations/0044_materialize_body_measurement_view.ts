import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0044_materialize_body_measurement_view",
    statements: [
      "DROP VIEW IF EXISTS analytics.v_body_measurement",
      "DROP TABLE IF EXISTS analytics.v_body_measurement",
    ],
  };
}
