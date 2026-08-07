import type { ClickHouseMigration } from "./types.ts";

const statements = [
  "ALTER TABLE postgres_fitness.daily_metrics DROP COLUMN IF EXISTS cycling_distance_km",
];

export function createMigration(): ClickHouseMigration {
  return {
    id: "0041_drop_daily_metrics_cycling_distance",
    statements,
  };
}
