import { buildClickHouseBootstrapStatements } from "../clickhouse.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(postgresConnectionString: string): ClickHouseMigration {
  return {
    id: "0007_remaining_postgres_views_to_clickhouse",
    statements: [
      "DROP VIEW IF EXISTS analytics.activity_summary",
      "DROP TABLE IF EXISTS analytics.activity_summary",
      "DROP TABLE IF EXISTS analytics.deduped_sensor",
      "DROP VIEW IF EXISTS analytics.v_activity_members",
      "DROP TABLE IF EXISTS analytics.v_activity_members",
      "DROP VIEW IF EXISTS analytics.v_activity",
      "DROP TABLE IF EXISTS analytics.v_activity",
      "DROP VIEW IF EXISTS analytics.v_sleep",
      "DROP TABLE IF EXISTS analytics.v_sleep",
      "DROP VIEW IF EXISTS analytics.v_body_measurement",
      "DROP TABLE IF EXISTS analytics.v_body_measurement",
      "DROP VIEW IF EXISTS analytics.v_daily_metrics",
      "DROP TABLE IF EXISTS analytics.v_daily_metrics",
      "DROP VIEW IF EXISTS analytics.derived_resting_heart_rate",
      "DROP TABLE IF EXISTS analytics.derived_resting_heart_rate",
      "DROP VIEW IF EXISTS analytics.provider_stats",
      "DROP TABLE IF EXISTS analytics.provider_stats",
      ...buildClickHouseBootstrapStatements(postgresConnectionString),
    ],
  };
}
