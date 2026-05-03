import { Client, escapeIdentifier } from "pg";
import { z } from "zod";
import {
  buildClickHouseBootstrapStatements,
  type ClickHouseCommandClient,
  parsePostgresConnectionForClickHouse,
  waitForClickHouseTable,
} from "./clickhouse.ts";

interface MigrationCountRow {
  migration_count: number | string;
}

interface MetricStreamBackfillChunkRow {
  lower_bound: string | null;
  upper_bound: string | null;
}

interface MetricStreamBackfillChunkRange {
  lower_bound: string;
  upper_bound: string;
}
interface MetricStreamBackfillRange {
  lowerBound: Date;
  upperBound: Date;
}

interface TimescaleChunkRow {
  chunk_schema: string;
  chunk_name: string;
}

const metricStreamBackfillChunkRowSchema = z.object({
  lower_bound: z.string().nullable(),
  upper_bound: z.string().nullable(),
});

const timescaleChunkRowSchema = z.object({
  chunk_schema: z.string(),
  chunk_name: z.string(),
});

interface MetricStreamBackfillChunkCountRow {
  chunk_count: number | string;
}
interface ClickHouseDatabaseEngineRow {
  engine: string;
}

const clickHouseDatabaseEngineRowSchema = z.object({
  engine: z.string(),
});

const METRIC_STREAM_BACKFILL_RANGE_MILLISECONDS = 6 * 60 * 60 * 1_000;

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
      statements: [],
    },
    {
      id: "0006_backfill_native_metric_stream",
      run: replaceNativeMetricStreamAndBackfill,
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

async function replaceNativeMetricStreamAndBackfill(
  client: ClickHouseCommandClient,
  postgresConnectionString: string,
): Promise<void> {
  const resetStatements = [
    "DROP VIEW IF EXISTS analytics.activity_summary",
    "DROP TABLE IF EXISTS analytics.activity_summary",
    "DROP VIEW IF EXISTS analytics.deduped_sensor",
    "DROP TABLE IF EXISTS analytics.deduped_sensor",
  ];

  for (const statement of resetStatements) {
    await runClickHouseMigrationStatement(client, statement);
  }

  if (await shouldReplacePostgresFitnessDatabase(client)) {
    await runClickHouseMigrationStatement(
      client,
      "DROP TABLE IF EXISTS analytics.metric_stream_backfill_chunks",
    );
    await runClickHouseMigrationStatement(client, "DROP DATABASE IF EXISTS postgres_fitness SYNC");
  }

  for (const statement of buildClickHouseBootstrapStatements(postgresConnectionString)) {
    await runClickHouseMigrationStatement(client, statement);
  }

  await backfillNativeMetricStream(client, postgresConnectionString);
  await runClickHouseMigrationStatement(client, "SYSTEM REFRESH VIEW analytics.deduped_sensor");
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.deduped_sensor");
  await runClickHouseMigrationStatement(client, "SYSTEM REFRESH VIEW analytics.activity_summary");
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.activity_summary");
}

async function shouldReplacePostgresFitnessDatabase(
  client: ClickHouseCommandClient,
): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }
  const result = await client.query<ClickHouseDatabaseEngineRow>({
    query: "SELECT engine FROM system.databases WHERE name = 'postgres_fitness'",
    format: "JSONEachRow",
  });
  const rows = await result.json();
  if (!rows[0]) {
    return false;
  }
  const row = clickHouseDatabaseEngineRowSchema.parse(rows[0]);
  return row.engine !== "Atomic" && row.engine !== "Ordinary";
}

async function backfillNativeMetricStream(
  client: ClickHouseCommandClient,
  postgresConnectionString: string,
): Promise<void> {
  await waitForClickHouseTable(client, "postgres_fitness", "metric_stream");
  const timescaleChunks = await fetchMetricStreamBackfillChunks(postgresConnectionString);
  const backfillRanges = timescaleChunks.flatMap(splitMetricStreamBackfillChunk);
  if (backfillRanges.length === 0) {
    return;
  }

  const postgresMetricStreamSource =
    buildPostgresMetricStreamTableFunction(postgresConnectionString);
  await client.command({
    query: `CREATE TABLE IF NOT EXISTS analytics.metric_stream_backfill_chunks (
  lower_bound DateTime64(6, 'UTC'),
  upper_bound DateTime64(6, 'UTC'),
  completed_at DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY (lower_bound, upper_bound)`,
  });

  for (const backfillRange of backfillRanges) {
    if (
      await isMetricStreamBackfillChunkComplete(
        client,
        backfillRange.lowerBound,
        backfillRange.upperBound,
      )
    ) {
      continue;
    }
    await client.command({
      query: buildMetricStreamBackfillStatement(
        postgresMetricStreamSource,
        backfillRange.lowerBound,
        backfillRange.upperBound,
      ),
    });
    await client.command({
      query: `INSERT INTO analytics.metric_stream_backfill_chunks (lower_bound, upper_bound)
VALUES (${clickHouseDateTimeLiteral(backfillRange.lowerBound)}, ${clickHouseDateTimeLiteral(backfillRange.upperBound)})`,
    });
  }
}

function splitMetricStreamBackfillChunk(
  chunk: MetricStreamBackfillChunkRange,
): MetricStreamBackfillRange[] {
  const chunkStart = parsePostgresTimestamp(chunk.lower_bound, "metric_stream chunk lower bound");
  const chunkEnd = parsePostgresTimestamp(chunk.upper_bound, "metric_stream chunk upper bound");
  const ranges: MetricStreamBackfillRange[] = [];

  for (
    let rangeStart = chunkStart;
    rangeStart < chunkEnd;
    rangeStart = new Date(rangeStart.getTime() + METRIC_STREAM_BACKFILL_RANGE_MILLISECONDS)
  ) {
    const nextRangeEnd = new Date(
      Math.min(
        rangeStart.getTime() + METRIC_STREAM_BACKFILL_RANGE_MILLISECONDS,
        chunkEnd.getTime(),
      ),
    );
    ranges.push({ lowerBound: rangeStart, upperBound: nextRangeEnd });
  }

  return ranges;
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
WHERE lower_bound <= ${clickHouseDateTimeLiteral(chunkStart)}
  AND upper_bound >= ${clickHouseDateTimeLiteral(chunkEnd)}`,
    format: "JSONEachRow",
  });
  const rows = await result.json();
  return Number(rows[0]?.chunk_count ?? 0) > 0;
}

async function fetchMetricStreamBackfillChunks(
  postgresConnectionString: string,
): Promise<MetricStreamBackfillChunkRange[]> {
  const postgresClient = new Client({ connectionString: postgresConnectionString });
  try {
    await postgresClient.connect();
    const chunksResult = await postgresClient.query<TimescaleChunkRow>(`
      SELECT
        chunk_schema,
        chunk_name
      FROM timescaledb_information.chunks
      WHERE hypertable_schema = 'fitness'
        AND hypertable_name = 'metric_stream'
      ORDER BY range_start ASC
    `);
    const chunks = chunksResult.rows.map((row) => timescaleChunkRowSchema.parse(row));
    const chunkBounds: MetricStreamBackfillChunkRange[] = [];
    for (const chunk of chunks) {
      const chunkTable = `${escapeIdentifier(chunk.chunk_schema)}.${escapeIdentifier(
        chunk.chunk_name,
      )}`;
      const chunkBoundsResult = await postgresClient.query<MetricStreamBackfillChunkRow>(`
        SELECT
          to_char(min(recorded_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS lower_bound,
          to_char((max(recorded_at) + interval '1 microsecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS upper_bound
        FROM ${chunkTable}
      `);
      const bounds = metricStreamBackfillChunkRowSchema.parse(chunkBoundsResult.rows[0]);
      if (bounds.lower_bound && bounds.upper_bound) {
        chunkBounds.push({
          lower_bound: bounds.lower_bound,
          upper_bound: bounds.upper_bound,
        });
      }
    }
    return chunkBounds;
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
  channel,
  activity_id,
  scalar,
  id
)
SELECT
  metric_stream.recorded_at,
  metric_stream.user_id,
  metric_stream.provider_id,
  metric_stream.channel,
  metric_stream.activity_id,
  metric_stream.scalar,
  metric_stream.id
FROM ${postgresMetricStreamSource} AS metric_stream
LEFT JOIN (
  SELECT id
  FROM postgres_fitness.metric_stream
  WHERE recorded_at >= ${lowerBound}
    AND recorded_at < ${upperBound}
) AS existing_metric_stream
  ON existing_metric_stream.id = metric_stream.id
WHERE metric_stream.recorded_at >= ${lowerBound}
  AND metric_stream.recorded_at < ${upperBound}
  AND existing_metric_stream.id IS NULL`;
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
      allow_experimental_refreshable_materialized_view: 1,
    },
  });
}
