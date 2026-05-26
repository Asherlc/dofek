import { buildActivityVo2MaxEstimateTableSql } from "../clickhouse-activity-vo2max-estimate.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0023_incremental_activity_vo2max_estimate",
    statements: [
      "DROP TABLE IF EXISTS analytics.activity_vo2max_estimate",
      buildActivityVo2MaxEstimateTableSql(),
    ],
  };
}
