import { Client } from "pg";
import {
  buildClickHouseBootstrapStatements,
  buildClickHousePlaceholderBootstrapStatements,
  type ClickHouseCommandClient,
  parsePostgresConnectionForClickHouse,
  waitForClickHouseTable,
} from "./clickhouse.ts";

interface MigrationCountRow {
  migration_count: number | string;
}

interface MetricStreamBackfillBoundsRow {
  min_recorded_at: string | null;
  upper_bound: string | null;
}

interface MetricStreamBackfillChunkCountRow {
  chunk_count: number | string;
}

const METRIC_STREAM_BACKFILL_CHUNK_MS = 6 * 60 * 60 * 1000;

function clickHouseStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

type ClickHouseMigration =
  | {
      id: string;
      statements: string[];
    }
  | {
      id: string;
      run: (client: ClickHouseCommandClient, postgresConnectionString: string) => Promise<void>;
    };

function clickHouseMigrations(postgresConnectionString: string): ClickHouseMigration[] {
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
    {
      id: "0003_disable_materialized_metric_stream",
      statements: [
        "DROP VIEW IF EXISTS analytics.activity_summary",
        "DROP TABLE IF EXISTS analytics.activity_summary",
        "DROP VIEW IF EXISTS analytics.deduped_sensor",
        "DROP TABLE IF EXISTS analytics.deduped_sensor",
        "DROP DATABASE IF EXISTS postgres_fitness SYNC",
        ...buildClickHousePlaceholderBootstrapStatements(postgresConnectionString),
      ],
    },
    {
      id: "0004_reenable_materialized_metric_stream",
      statements: [
        "DROP VIEW IF EXISTS analytics.activity_summary",
        "DROP TABLE IF EXISTS analytics.activity_summary",
        "DROP VIEW IF EXISTS analytics.deduped_sensor",
        "DROP TABLE IF EXISTS analytics.deduped_sensor",
        "DROP DATABASE IF EXISTS postgres_fitness SYNC",
        ...buildClickHouseBootstrapStatements(postgresConnectionString),
      ],
    },
    {
      id: "0005_backfill_materialized_metric_stream",
      run: backfillMaterializedMetricStream,
    },
  ];
}

export function buildClickHouseMigrationStatements(postgresConnectionString: string): string[] {
  return clickHouseMigrations(postgresConnectionString).flatMap((migration) =>
    "statements" in migration ? migration.statements : [],
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

    if ("statements" in migration) {
      for (const statement of migration.statements) {
        await runClickHouseMigrationStatement(client, statement);
      }
    } else {
      await migration.run(client, postgresConnectionString);
    }
    await client.command({
      query: `INSERT INTO analytics.schema_migrations (id) VALUES (${migrationId})`,
    });
    appliedCount += 1;
  }

  return appliedCount;
}

async function backfillMaterializedMetricStream(
  client: ClickHouseCommandClient,
  postgresConnectionString: string,
): Promise<void> {
  await waitForClickHouseTable(client, "postgres_fitness", "metric_stream");
  const bounds = await fetchMetricStreamBackfillBounds(postgresConnectionString);
  if (!bounds.min_recorded_at || !bounds.upper_bound) {
    return;
  }

  const postgresMetricStreamSource =
    buildPostgresMetricStreamTableFunction(postgresConnectionString);
  const upperBound = parsePostgresTimestamp(bounds.upper_bound, "metric_stream upper bound");
  let chunkStart = parsePostgresTimestamp(bounds.min_recorded_at, "metric_stream lower bound");
  await client.command({
    query: `CREATE TABLE IF NOT EXISTS analytics.metric_stream_backfill_chunks (
  lower_bound DateTime64(6, 'UTC'),
  upper_bound DateTime64(6, 'UTC'),
  completed_at DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY (lower_bound, upper_bound)`,
  });

  while (chunkStart.getTime() < upperBound.getTime()) {
    const chunkEnd = new Date(
      Math.min(chunkStart.getTime() + METRIC_STREAM_BACKFILL_CHUNK_MS, upperBound.getTime()),
    );
    if (await isMetricStreamBackfillChunkComplete(client, chunkStart, chunkEnd)) {
      chunkStart = chunkEnd;
      continue;
    }
    await client.command({
      query: buildMetricStreamBackfillStatement(postgresMetricStreamSource, chunkStart, chunkEnd),
      clickhouse_settings: {
        allow_experimental_database_materialized_postgresql: 1,
      },
    });
    await client.command({
      query: `INSERT INTO analytics.metric_stream_backfill_chunks (lower_bound, upper_bound)
VALUES (${clickHouseDateTimeLiteral(chunkStart)}, ${clickHouseDateTimeLiteral(chunkEnd)})`,
    });
    chunkStart = chunkEnd;
  }
}

async function isMetricStreamBackfillChunkComplete(
  client: ClickHouseCommandClient,
  chunkStart: Date,
  chunkEnd: Date,
): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse metric stream backfill requires a query-capable client");
  }
  const result = await client.query<MetricStreamBackfillChunkCountRow>({
    query: `SELECT count() AS chunk_count
FROM analytics.metric_stream_backfill_chunks
WHERE lower_bound = ${clickHouseDateTimeLiteral(chunkStart)}
  AND upper_bound = ${clickHouseDateTimeLiteral(chunkEnd)}`,
    format: "JSONEachRow",
  });
  const rows = await result.json();
  return Number(rows[0]?.chunk_count ?? 0) > 0;
}

async function fetchMetricStreamBackfillBounds(
  postgresConnectionString: string,
): Promise<MetricStreamBackfillBoundsRow> {
  const postgresClient = new Client({ connectionString: postgresConnectionString });
  try {
    await postgresClient.connect();
    const result = await postgresClient.query<MetricStreamBackfillBoundsRow>(`
      SELECT
        (
          SELECT recorded_at::text
          FROM fitness.metric_stream
          ORDER BY recorded_at ASC
          LIMIT 1
        ) AS min_recorded_at,
        (
          SELECT greatest(clock_timestamp(), recorded_at + interval '1 second')::text
          FROM fitness.metric_stream
          ORDER BY recorded_at DESC
          LIMIT 1
        ) AS upper_bound
    `);
    return result.rows[0] ?? { min_recorded_at: null, upper_bound: null };
  } finally {
    await postgresClient.end();
  }
}

function buildPostgresMetricStreamTableFunction(postgresConnectionString: string): string {
  const postgres = parsePostgresConnectionForClickHouse(postgresConnectionString);
  return `postgresql(${clickHouseStringLiteral(postgres.hostAndPort)}, ${clickHouseStringLiteral(
    postgres.database,
  )}, 'metric_stream', ${clickHouseStringLiteral(postgres.user)}, ${clickHouseStringLiteral(
    postgres.password,
  )}, 'fitness')`;
}

function parsePostgresTimestamp(value: string, label: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function buildMetricStreamBackfillStatement(
  postgresMetricStreamSource: string,
  chunkStart: Date,
  chunkEnd: Date,
): string {
  const lowerBound = clickHouseDateTimeLiteral(chunkStart);
  const upperBound = clickHouseDateTimeLiteral(chunkEnd);
  return `INSERT INTO postgres_fitness.metric_stream (
  recorded_at,
  user_id,
  provider_id,
  device_id,
  source_type,
  channel,
  activity_id,
  scalar,
  vector,
  id
)
SELECT
  metric_stream.recorded_at,
  metric_stream.user_id,
  metric_stream.provider_id,
  metric_stream.device_id,
  metric_stream.source_type,
  metric_stream.channel,
  metric_stream.activity_id,
  metric_stream.scalar,
  metric_stream.vector,
  metric_stream.id
FROM ${postgresMetricStreamSource} AS metric_stream
WHERE metric_stream.recorded_at >= ${lowerBound}
  AND metric_stream.recorded_at < ${upperBound}`;
}

function clickHouseDateTimeLiteral(value: Date): string {
  const clickHouseTimestamp = value.toISOString().replace("T", " ").replace("Z", "");
  return `toDateTime64(${clickHouseStringLiteral(clickHouseTimestamp)}, 6, 'UTC')`;
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
