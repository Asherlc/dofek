import { createClient } from "@clickhouse/client";
import { Client as PostgresClient } from "pg";

export interface ClickHouseCommandClient {
  command(options: { query: string }): Promise<unknown>;
  query<TRow extends object>(options: {
    query: string;
    format: "JSONEachRow";
  }): Promise<{ json(): Promise<TRow[]> }>;
  insert<TRow extends object>(options: {
    table: string;
    values: readonly TRow[];
    format: "JSONEachRow";
  }): Promise<unknown>;
  close?(): Promise<void>;
}

export interface PostgresQueryClient {
  query<TRow extends object>(text: string, values?: readonly unknown[]): Promise<{ rows: TRow[] }>;
  end?(): Promise<void>;
}

interface MaxRecordedAtRow {
  max_recorded_at: string | null;
}

interface PostgresMetricStreamRow {
  recorded_at: string;
  user_id: string;
  provider_id: string;
  device_id: string | null;
  source_type: string;
  channel: string;
  activity_id: string | null;
  scalar: number | null;
}

interface PostgresAdvisoryLockRow {
  locked: boolean;
}

export interface ClickHouseMetricStreamRow {
  recorded_at: string;
  user_id: string;
  provider_id: string;
  device_id: string | null;
  source_type: string;
  channel: string;
  activity_id: string | null;
  scalar: number | null;
}

export interface SyncClickHouseMetricStreamOptions {
  clickHouseClient: ClickHouseCommandClient;
  postgresClient: PostgresQueryClient;
  batchSize?: number;
  lookbackHours?: number;
}

export function buildClickHouseBootstrapStatements(): string[] {
  return [
    "CREATE DATABASE IF NOT EXISTS fitness",
    `CREATE TABLE IF NOT EXISTS fitness.metric_stream (
  recorded_at DateTime64(3, 'UTC'),
  user_id UUID,
  provider_id LowCardinality(String),
  device_id Nullable(String),
  source_type LowCardinality(String),
  channel LowCardinality(String),
  activity_id Nullable(UUID),
  scalar Nullable(Float64),
  synced_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(synced_at)
ORDER BY (user_id, activity_id, channel, recorded_at, provider_id, source_type, device_id)
SETTINGS allow_nullable_key = 1`,
    `CREATE TABLE IF NOT EXISTS fitness.metric_stream_sync_log (
  synced_at DateTime64(3, 'UTC') DEFAULT now64(3),
  started_at DateTime64(3, 'UTC'),
  row_count UInt64
)
ENGINE = MergeTree()
ORDER BY synced_at`,
  ];
}

export function createClickHouseClientFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const url = env.CLICKHOUSE_URL;
  if (!url) {
    throw new Error("CLICKHOUSE_URL environment variable is required");
  }
  return createClient({ url });
}

export function createPostgresClientFromEnv(env: NodeJS.ProcessEnv = process.env): PostgresClient {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  return new PostgresClient({ connectionString });
}

export async function bootstrapClickHouse(client: ClickHouseCommandClient): Promise<void> {
  for (const statement of buildClickHouseBootstrapStatements()) {
    await client.command({ query: statement });
  }
}

function syncStart(maxRecordedAt: string | null, lookbackHours: number): string {
  if (!maxRecordedAt) {
    return "1970-01-01T00:00:00.000Z";
  }
  const start = new Date(maxRecordedAt);
  start.setUTCHours(start.getUTCHours() - lookbackHours);
  return start.toISOString();
}

function toClickHouseDateTime(value: string): string {
  return new Date(value).toISOString().replace("T", " ").replace("Z", "");
}

function mapMetricStreamRow(row: PostgresMetricStreamRow): ClickHouseMetricStreamRow {
  return {
    recorded_at: toClickHouseDateTime(row.recorded_at),
    user_id: row.user_id,
    provider_id: row.provider_id,
    device_id: row.device_id,
    source_type: row.source_type,
    channel: row.channel,
    activity_id: row.activity_id,
    scalar: row.scalar,
  };
}

async function maxRecordedAt(client: ClickHouseCommandClient): Promise<string | null> {
  const result = await client.query<MaxRecordedAtRow>({
    query: "SELECT toString(max(recorded_at)) AS max_recorded_at FROM fitness.metric_stream FINAL",
    format: "JSONEachRow",
  });
  const rows = await result.json();
  return rows[0]?.max_recorded_at ?? null;
}

export async function syncClickHouseMetricStream(
  options: SyncClickHouseMetricStreamOptions,
): Promise<number> {
  const batchSize = options.batchSize ?? 10_000;
  const lookbackHours = options.lookbackHours ?? 48;
  await bootstrapClickHouse(options.clickHouseClient);
  const start = syncStart(await maxRecordedAt(options.clickHouseClient), lookbackHours);
  let offset = 0;
  let rowCount = 0;

  for (;;) {
    const result = await options.postgresClient.query<PostgresMetricStreamRow>(
      `SELECT
         recorded_at::text AS recorded_at,
         user_id::text AS user_id,
         provider_id,
         device_id,
         source_type,
         channel,
         activity_id::text AS activity_id,
         scalar
       FROM fitness.metric_stream
       WHERE recorded_at >= $1::timestamptz
       ORDER BY recorded_at, user_id, provider_id, channel, source_type
       LIMIT $2 OFFSET $3`,
      [start, batchSize, offset],
    );
    if (result.rows.length === 0) break;

    await options.clickHouseClient.insert({
      table: "fitness.metric_stream",
      values: result.rows.map(mapMetricStreamRow),
      format: "JSONEachRow",
    });
    rowCount += result.rows.length;
    offset += result.rows.length;
  }

  await options.clickHouseClient.insert({
    table: "fitness.metric_stream_sync_log",
    values: [{ started_at: toClickHouseDateTime(start), row_count: rowCount }],
    format: "JSONEachRow",
  });

  return rowCount;
}

export async function syncClickHouseMetricStreamFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const clickHouseClient = createClickHouseClientFromEnv(env);
  const postgresClient = createPostgresClientFromEnv(env);
  await postgresClient.connect();
  let locked = false;
  try {
    const lockResult = await postgresClient.query<PostgresAdvisoryLockRow>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      ["dofek_clickhouse_metric_stream_sync"],
    );
    if (!lockResult.rows[0]?.locked) {
      return 0;
    }
    locked = true;
    return await syncClickHouseMetricStream({ clickHouseClient, postgresClient });
  } finally {
    if (locked) {
      await postgresClient.query("SELECT pg_advisory_unlock(hashtext($1))", [
        "dofek_clickhouse_metric_stream_sync",
      ]);
    }
    await postgresClient.end();
    await clickHouseClient.close();
  }
}
