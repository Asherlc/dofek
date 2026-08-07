import { buildRestingHeartRateSleepWindowTableSql } from "../clickhouse-resting-heart-rate.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0021_incremental_resting_heart_rate",
    statements: [
      "DROP TABLE IF EXISTS analytics.resting_heart_rate_sleep_dirty_key_ingest",
      "DROP TABLE IF EXISTS analytics.resting_heart_rate_activity_dirty_key_ingest",
      "DROP TABLE IF EXISTS analytics.resting_heart_rate_sleep_window",
      "DROP TABLE IF EXISTS analytics.resting_heart_rate_dirty_key",
      "DROP TABLE IF EXISTS analytics.sensor_scalar_sample_ingest",
      "DROP TABLE IF EXISTS analytics.sensor_dirty_key_ingest",
      "DROP TABLE IF EXISTS analytics.sensor_dirty_key",
      buildRestingHeartRateSleepWindowTableSql(),
    ],
  };
}
