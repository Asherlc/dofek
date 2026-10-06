import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0101_activity_end_time_nullability",
    phase: "pre-cdc",
    statements: [
      "ALTER TABLE postgres_fitness.activity MODIFY COLUMN ended_at Nullable(DateTime64(6, 'UTC'))",
      "ALTER TABLE analytics.deduped_activities MODIFY COLUMN ended_at Nullable(DateTime64(6, 'UTC'))",
    ],
  };
}
