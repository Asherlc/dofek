import { buildActivityTrendDailyReadModelStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0011_activity_trend_daily_read_model",
    statements: buildActivityTrendDailyReadModelStatements(),
  };
}
