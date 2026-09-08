import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0078_sensor_provider_priority_type",
    statements: [
      "ALTER TABLE analytics.sensor_scalar_sample MODIFY COLUMN IF EXISTS provider_priority Int32",
      "ALTER TABLE analytics.deduped_sensor MODIFY COLUMN IF EXISTS provider_priority Int32",
    ],
  };
}
