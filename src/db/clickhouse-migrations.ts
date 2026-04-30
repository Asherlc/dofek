import {
  buildClickHouseBootstrapStatements,
  type ClickHouseCommandClient,
  waitForClickHouseTable,
} from "./clickhouse.ts";

interface MigrationCountRow {
  migration_count: number | string;
}

function clickHouseStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function clickHouseMigrations(postgresConnectionString: string) {
  return [
    {
      id: "0001_clickhouse_analytics_schema_cleanup",
      statements: [
        "DROP VIEW IF EXISTS analytics.activity_summary",
        "DROP TABLE IF EXISTS analytics.activity_summary",
        "DROP VIEW IF EXISTS analytics.deduped_sensor",
        "DROP TABLE IF EXISTS analytics.deduped_sensor",
        "DROP VIEW IF EXISTS fitness.activity_summary",
        "DROP TABLE IF EXISTS fitness.activity_summary",
        "DROP VIEW IF EXISTS fitness.deduped_sensor",
        "DROP TABLE IF EXISTS fitness.deduped_sensor",
        "DROP TABLE IF EXISTS fitness.activity_sensor_window",
        "DROP TABLE IF EXISTS fitness.metric_stream_sync_log",
        "DROP TABLE IF EXISTS fitness.metric_stream",
      ],
    },
    {
      id: "0002_clickhouse_postgres_bridge_and_activity_read_models",
      statements: buildClickHouseBootstrapStatements(postgresConnectionString),
    },
  ];
}

export function buildClickHouseMigrationStatements(postgresConnectionString: string): string[] {
  return clickHouseMigrations(postgresConnectionString).flatMap(
    (migration) => migration.statements,
  );
}

export async function runClickHouseMigrations(
  client: ClickHouseCommandClient,
  postgresConnectionString: string,
): Promise<number> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }

  await client.command({ query: "CREATE DATABASE IF NOT EXISTS analytics" });
  await client.command({ query: "CREATE DATABASE IF NOT EXISTS fitness" });
  await client.command({
    query: `CREATE TABLE IF NOT EXISTS analytics.schema_migrations (
  id String,
  applied_at DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY id`,
  });

  let appliedCount = 0;
  for (const migration of clickHouseMigrations(postgresConnectionString)) {
    const migrationId = clickHouseStringLiteral(migration.id);
    const result = await client.query<MigrationCountRow>({
      query: `SELECT count() AS migration_count FROM analytics.schema_migrations WHERE id = ${migrationId}`,
      format: "JSONEachRow",
    });
    const rows = await result.json();
    if (Number(rows[0]?.migration_count ?? 0) > 0) {
      continue;
    }

    for (const statement of migration.statements) {
      await runClickHouseMigrationStatement(client, statement);
    }
    await client.command({
      query: `INSERT INTO analytics.schema_migrations (id) VALUES (${migrationId})`,
    });
    appliedCount += 1;
  }

  return appliedCount;
}

async function runClickHouseMigrationStatement(
  client: ClickHouseCommandClient,
  statement: string,
): Promise<void> {
  if (statement.startsWith("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor")) {
    await waitForClickHouseTable(client, "postgres_fitness", "metric_stream");
  }
  if (statement.startsWith("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_summary")) {
    await waitForClickHouseTable(client, "analytics", "deduped_sensor");
  }

  await client.command({
    query: statement,
    clickhouse_settings: {
      allow_experimental_database_materialized_postgresql: 1,
      allow_experimental_refreshable_materialized_view: 1,
    },
  });
}
