import type { ClickHouseClient } from "../../../../src/db/clickhouse.ts";
import { createMigration } from "../../../../src/db/clickhouse-migrations/0111_daily_health_sensor.ts";
import { readModelSql, renderDbtModelSql } from "../../../../src/db/read-model-sql-test-helpers.ts";

/** Build the current dbt model over the fixture's raw samples, without historical migrations. */
export async function refreshDailyHealthSensor(client: ClickHouseClient, database: string) {
  await client.command({
    query: `CREATE TABLE IF NOT EXISTS ${database}.metric_stream_day_change (
      user_id UUID, provider_id String, recorded_date Date, changed_at DateTime64(9, 'UTC')
    ) ENGINE=MergeTree ORDER BY (user_id, provider_id, recorded_date)`,
  });
  await client.command({
    query: `INSERT INTO ${database}.metric_stream_day_change
      SELECT user_id, provider_id, toDate(recorded_at), now64(9)
      FROM ${database}.metric_stream GROUP BY user_id, provider_id, toDate(recorded_at)`,
  });
  for (const statement of createMigration().statements) {
    await client.command({ query: statement.replaceAll("analytics.", `${database}.`) });
  }
  await buildDailyHealthSensor(client, database);
}

export async function buildDailyHealthSensor(client: ClickHouseClient, database: string) {
  await client.command({
    query: `INSERT INTO ${database}.daily_health_sensor ${dailyHealthSensorModelSql(database)}`,
    clickhouse_settings: { join_use_nulls: 1, transform_null_in: 1, enable_materialized_cte: 1 },
  });
}

export function dailyHealthSensorModelSql(database: string) {
  return renderDbtModelSql(readModelSql("daily_health_sensor.sql"), { isIncremental: true })
    .replaceAll("{{ health_sensor_day_batch_size }}", "32")
    .replaceAll(
      "{{ source('analytics', 'metric_stream_day_change') }}",
      `${database}.metric_stream_day_change`,
    )
    .replaceAll("{{ source('ingest', 'metric_stream_current') }}", `${database}.metric_stream`)
    .replaceAll("{{ this }}", `${database}.daily_health_sensor`);
}
