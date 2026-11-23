import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0118_daily_sleep_wake_date_index",
    statements: [
      `ALTER TABLE analytics.daily_sleep ADD INDEX IF NOT EXISTS wake_utc_date_minmax
        toDate(coalesce(ended_at, addMinutes(started_at, ifNull(duration_minutes, 0))), 'UTC') TYPE minmax GRANULARITY 1`,
      "ALTER TABLE analytics.daily_sleep MATERIALIZE INDEX wake_utc_date_minmax SETTINGS mutations_sync = 2",
    ],
  };
}
