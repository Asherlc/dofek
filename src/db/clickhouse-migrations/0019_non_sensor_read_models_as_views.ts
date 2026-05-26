import { buildDedupedLocationReadModelStatements } from "../clickhouse-metric-stream-bootstrap.ts";
import { buildAnalyticsFitnessReadModelStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0019_non_sensor_read_models_as_views",
    statements: [
      "DROP TABLE IF EXISTS analytics.activity_summary",
      "DROP TABLE IF EXISTS analytics.activity_trend_daily",
      "DROP TABLE IF EXISTS analytics.resting_heart_rate_sleep_window",
      "DROP TABLE IF EXISTS analytics.deduped_location",
      "DROP TABLE IF EXISTS analytics.provider_stats",
      "DROP TABLE IF EXISTS analytics.v_daily_metrics",
      "DROP TABLE IF EXISTS analytics.v_body_measurement",
      "DROP TABLE IF EXISTS analytics.v_sleep",
      "DROP TABLE IF EXISTS analytics.v_activity_members",
      "DROP TABLE IF EXISTS analytics.v_activity",
      ...buildAnalyticsFitnessReadModelStatements(),
      ...buildDedupedLocationReadModelStatements(),
    ],
  };
}
