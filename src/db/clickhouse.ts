import { createClient } from "@clickhouse/client";
import { METRIC_STREAM_TABLE } from "../metric-stream/clickhouse-table.ts";
import { buildClickHouseBootstrapStatementsForNativeMetricStream } from "./clickhouse-metric-stream-bootstrap.ts";

export interface ClickHouseCommandClient {
  command(options: {
    query: string;
    clickhouse_settings?: Record<string, string | number | boolean>;
    query_params?: Record<string, unknown>;
  }): Promise<unknown>;
  insert?(options: {
    table: string;
    values: readonly object[];
    format: "JSONEachRow";
    clickhouse_settings?: Record<string, string | number | boolean>;
  }): Promise<unknown>;
  query?<TRow extends object>(options: {
    query: string;
    query_id?: string;
    format: "JSONEachRow";
    query_params?: Record<string, unknown>;
    abort_signal?: AbortSignal;
    clickhouse_settings?: Record<string, string | number | boolean>;
  }): Promise<{ json(): Promise<TRow[]> }>;
  close?(): Promise<void>;
}

export interface ClickHouseClient extends ClickHouseCommandClient {
  query<TRow extends object>(options: {
    query: string;
    query_id?: string;
    format: "JSONEachRow";
    query_params?: Record<string, unknown>;
    abort_signal?: AbortSignal;
    clickhouse_settings?: Record<string, string | number | boolean>;
  }): Promise<{ json(): Promise<TRow[]> }>;
}

interface ClickHouseClientOptions {
  requestTimeoutMs?: number;
}

interface TableCountRow {
  table_count: number | string;
}

interface ColumnCountRow {
  column_count: number | string;
}

const CLICKHOUSE_TABLE_WAIT_ATTEMPTS = 180;
const CLICKHOUSE_REQUEST_TIMEOUT_MILLISECONDS = 120_000;
export const CLICKHOUSE_DEFAULT_SETTINGS = {
  allow_experimental_nullable_tuple_type: 1,
} satisfies Record<string, string | number | boolean>;

interface ClickHousePostgresConnection {
  hostAndPort: string;
  database: string;
  user: string;
  password: string;
}

function clickHouseStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function normalizePostgresHostForClickHouse(hostname: string): string {
  const normalizedHostname = hostname === "[::1]" ? "::1" : hostname;
  if (
    normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1"
  ) {
    return "host.docker.internal";
  }
  return normalizedHostname;
}

export function parsePostgresConnectionForClickHouse(
  connectionString: string,
): ClickHousePostgresConnection {
  const url = new URL(connectionString);
  const database = url.pathname.replace(/^\//, "");
  if (!database) {
    throw new Error(
      "DATABASE_URL must include a database name for ClickHouse Postgres replication",
    );
  }

  const host = normalizePostgresHostForClickHouse(url.hostname);
  const port = url.port || "5432";

  return {
    hostAndPort: `${host}:${port}`,
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

export function buildClickHouseBootstrapStatements(postgresConnectionString: string): string[] {
  return buildClickHouseBootstrapStatementsForNativeMetricStream(postgresConnectionString);
}

export function createClickHouseClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ClickHouseClientOptions = {},
): ClickHouseClient {
  const url = env.CLICKHOUSE_URL;
  if (!url) {
    throw new Error("CLICKHOUSE_URL environment variable is required");
  }
  return createClient({
    url,
    request_timeout: options.requestTimeoutMs ?? CLICKHOUSE_REQUEST_TIMEOUT_MILLISECONDS,
    clickhouse_settings: CLICKHOUSE_DEFAULT_SETTINGS,
  });
}

export async function bootstrapClickHouseFromEnv(client: ClickHouseCommandClient): Promise<void> {
  await waitForClickHouseTable(client, "ingest", "metric_stream");
  await waitForClickHouseTable(client, "analytics", "deduped_sensor");
  await waitForClickHouseTable(client, "analytics", "deduped_activities");
  await waitForClickHouseTable(client, "analytics", "activity_summary");
  await waitForClickHouseTable(client, "analytics", "activity_trend_daily");
  await smokeTestClickHouseTable(client, METRIC_STREAM_TABLE);
  await smokeTestClickHouseTable(client, "analytics.deduped_sensor");
  await smokeTestClickHouseTable(client, "analytics.deduped_activities");
  await smokeTestClickHouseTable(client, "analytics.activity_summary");
  await smokeTestClickHouseTable(client, "analytics.activity_trend_daily");
}

async function smokeTestClickHouseTable(
  client: ClickHouseCommandClient,
  tableName: string,
): Promise<void> {
  if (!client.query) {
    throw new Error("ClickHouse smoke verification requires a query-capable client");
  }
  const [database, table] = tableName.split(".", 2);
  if (!database || !table) {
    throw new Error(
      `ClickHouse smoke verification requires database-qualified table: ${tableName}`,
    );
  }
  const result = await client.query<ColumnCountRow>({
    query: `SELECT count() AS column_count FROM system.columns WHERE database = ${clickHouseStringLiteral(
      database,
    )} AND table = ${clickHouseStringLiteral(table)}`,
    format: "JSONEachRow",
  });
  const rows = await result.json();
  if (Number(rows[0]?.column_count ?? 0) === 0) {
    throw new Error(`ClickHouse object ${tableName} has no visible columns`);
  }
}

export async function waitForClickHouseTable(
  client: ClickHouseCommandClient,
  database: string,
  table: string,
): Promise<void> {
  if (!client.query) {
    throw new Error("ClickHouse table verification requires a query-capable client");
  }

  let lastStartupError: Error | undefined;
  for (let attempt = 0; attempt < CLICKHOUSE_TABLE_WAIT_ATTEMPTS; attempt += 1) {
    try {
      const result = await client.query<TableCountRow>({
        query: `SELECT count() AS table_count FROM system.tables WHERE database = ${clickHouseStringLiteral(
          database,
        )} AND name = ${clickHouseStringLiteral(table)}`,
        format: "JSONEachRow",
      });
      const rows = await result.json();
      if (Number(rows[0]?.table_count ?? 0) > 0) {
        return;
      }
    } catch (error) {
      if (!isTransientClickHouseStartupError(error)) {
        throw error;
      }
      lastStartupError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const startupErrorMessage = lastStartupError
    ? `; last startup error: ${lastStartupError.message}`
    : "";
  throw new Error(
    `Timed out waiting for ClickHouse table ${database}.${table}${startupErrorMessage}`,
  );
}

function isTransientClickHouseStartupError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.includes("ECONNREFUSED") || error.message === "Timeout error.")
  );
}
