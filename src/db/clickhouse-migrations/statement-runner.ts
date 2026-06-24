import {
  CLICKHOUSE_DEFAULT_SETTINGS,
  type ClickHouseCommandClient,
  waitForClickHouseTable,
} from "../clickhouse.ts";

export async function runClickHouseMigrationStatement(
  client: ClickHouseCommandClient,
  statement: string,
): Promise<void> {
  if (statement.startsWith("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor")) {
    await waitForClickHouseTable(client, "ingest", "metric_stream");
    await waitForClickHouseTable(client, "analytics", "v_activity_members");
  }
  if (statement.startsWith("CREATE VIEW IF NOT EXISTS analytics.deduped_location")) {
    await waitForClickHouseTable(client, "ingest", "metric_stream");
    await waitForClickHouseTable(client, "analytics", "v_activity_members");
  }
  if (statement.startsWith("CREATE VIEW IF NOT EXISTS analytics.activity_summary")) {
    await waitForClickHouseTable(client, "analytics", "deduped_sensor");
    await waitForClickHouseTable(client, "analytics", "deduped_location");
    await waitForClickHouseTable(client, "analytics", "v_activity");
  }
  if (statement.startsWith("CREATE VIEW IF NOT EXISTS analytics.activity_trend_daily")) {
    await waitForClickHouseTable(client, "analytics", "deduped_sensor");
    await waitForClickHouseTable(client, "analytics", "v_activity");
  }
  await client.command({
    query: statement,
    clickhouse_settings: {
      ...CLICKHOUSE_DEFAULT_SETTINGS,
      allow_experimental_refreshable_materialized_view: 1,
    },
  });
}
