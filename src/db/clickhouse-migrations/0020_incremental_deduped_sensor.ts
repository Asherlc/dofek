import { buildActivityTrendDailyReadModelStatements } from "../clickhouse-activity-trend-read-model.ts";
import { buildIncrementalDedupedSensorMigrationStatements } from "../clickhouse-deduped-sensor.ts";
import { buildActivitySummaryReadModelStatements } from "../clickhouse-metric-stream-bootstrap.ts";
import { migrateIncrementalDedupedSensor } from "./custom-runs.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0020_incremental_deduped_sensor",
    statements: [
      "DROP VIEW IF EXISTS analytics.activity_summary",
      "DROP TABLE IF EXISTS analytics.activity_summary",
      "DROP VIEW IF EXISTS analytics.activity_trend_daily",
      "DROP TABLE IF EXISTS analytics.activity_trend_daily",
      "DROP VIEW IF EXISTS analytics.resting_heart_rate_sleep_window",
      "DROP TABLE IF EXISTS analytics.resting_heart_rate_sleep_window",
      ...buildIncrementalDedupedSensorMigrationStatements(),
      ...buildActivitySummaryReadModelStatements(),
      ...buildActivityTrendDailyReadModelStatements(),
    ],
    run: migrateIncrementalDedupedSensor,
  };
}
