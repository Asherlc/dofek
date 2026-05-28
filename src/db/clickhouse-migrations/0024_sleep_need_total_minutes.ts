import { buildSleepReadModelStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0024_sleep_need_total_minutes",
    statements: [
      "ALTER TABLE postgres_fitness.sleep_session ADD COLUMN IF NOT EXISTS sleep_need_total_minutes Nullable(Int32) AFTER sleep_type",
      ...buildSleepReadModelStatements(),
    ],
  };
}
