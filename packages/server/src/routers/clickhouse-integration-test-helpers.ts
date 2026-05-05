import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  type ClickHouseClient,
  createClickHouseClientFromEnv,
} from "../../../../src/db/clickhouse.ts";
import { runClickHouseMigrations } from "../../../../src/db/clickhouse-migrations.ts";
import type { TestContext } from "../../../../src/db/test-helpers.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { ClickHouseActivitySensorStore } from "../repositories/clickhouse-activity-sensor-store.ts";

interface IsolatedClickHouseDatabases {
  analytics: string;
  postgresFitness: string;
  postgresFitnessLive: string;
}

interface ClickHouseTestHandle {
  client: ClickHouseClient;
}

interface MetricStreamSyncRow extends Record<string, unknown> {
  id: string;
  activity_id: string | null;
  user_id: string;
  recorded_at: string;
  channel: string;
  provider_id: string;
  scalar: number | null;
}

const handlesByContext = new WeakMap<TestContext, ClickHouseTestHandle>();

function clickHouseStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function clickHouseNullableUuid(value: string | null): string {
  return value == null ? "NULL" : `toUUID(${clickHouseStringLiteral(value)})`;
}

function clickHouseNullableFloat(value: number | null): string {
  return value == null ? "NULL" : String(value);
}

function metricStreamRowValues(row: MetricStreamSyncRow): string {
  return `(
  toUUID(${clickHouseStringLiteral(row.id)}),
  ${clickHouseNullableUuid(row.activity_id)},
  toUUID(${clickHouseStringLiteral(row.user_id)}),
  toDateTime64(${clickHouseStringLiteral(row.recorded_at)}, 6, 'UTC'),
  ${clickHouseStringLiteral(row.channel)},
  ${clickHouseStringLiteral(row.provider_id)},
  ${clickHouseNullableFloat(row.scalar)}
)`;
}

function rewriteClickHouseDatabaseNames(
  query: string,
  databases: IsolatedClickHouseDatabases,
): string {
  return query
    .replace(/\bpostgres_fitness_live\b/g, databases.postgresFitnessLive)
    .replace(/\bpostgres_fitness\b/g, databases.postgresFitness)
    .replace(/\banalytics\b/g, databases.analytics);
}

function createIsolatedClickHouseClient(
  client: ClickHouseClient,
  databases: IsolatedClickHouseDatabases,
): ClickHouseClient {
  return {
    command: (options) =>
      client.command({
        ...options,
        query: rewriteClickHouseDatabaseNames(options.query, databases),
      }),
    query: <TRow extends object>(options: {
      query: string;
      format: "JSONEachRow";
      query_params?: Record<string, unknown>;
    }) =>
      client.query<TRow>({
        ...options,
        query: rewriteClickHouseDatabaseNames(options.query, databases),
      }),
    close: () => client.close?.() ?? Promise.resolve(),
  };
}

export async function createClickHouseTestActivitySensorStore(
  testContext: TestContext,
): Promise<ActivitySensorStore> {
  const suffix = randomBytes(6).toString("hex");
  const databases = {
    analytics: `analytics_test_${suffix}`,
    postgresFitness: `postgres_fitness_test_${suffix}`,
    postgresFitnessLive: `postgres_fitness_live_test_${suffix}`,
  };
  const rawClient = createClickHouseClientFromEnv();
  const client = createIsolatedClickHouseClient(rawClient, databases);
  handlesByContext.set(testContext, { client });

  testContext.addCleanup(async () => {
    handlesByContext.delete(testContext);
    await rawClient.command({ query: `DROP DATABASE IF EXISTS ${databases.analytics} SYNC` });
    await rawClient.command({ query: `DROP DATABASE IF EXISTS ${databases.postgresFitness} SYNC` });
    await rawClient.command({
      query: `DROP DATABASE IF EXISTS ${databases.postgresFitnessLive} SYNC`,
    });
    await rawClient.close?.();
  });

  await runClickHouseMigrations(client, testContext.connectionString);
  await syncClickHouseTestActivitySensorStore(testContext);

  return new ClickHouseActivitySensorStore(client);
}

export async function syncClickHouseTestActivitySensorStore(
  testContext: TestContext,
): Promise<void> {
  const handle = handlesByContext.get(testContext);
  if (!handle) {
    throw new Error("ClickHouse test activity sensor store has not been created");
  }
  const rows = await testContext.db.execute<MetricStreamSyncRow>(
    sql`SELECT
      id::text AS id,
      activity_id::text AS activity_id,
      user_id::text AS user_id,
      to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS recorded_at,
      channel,
      provider_id,
      scalar
    FROM fitness.metric_stream
    ORDER BY recorded_at, id`,
  );

  await handle.client.command({ query: "TRUNCATE TABLE postgres_fitness.metric_stream" });
  if (rows.length > 0) {
    await handle.client.command({
      query: `INSERT INTO postgres_fitness.metric_stream (
  id,
  activity_id,
  user_id,
  recorded_at,
  channel,
  provider_id,
  scalar
)
VALUES ${rows.map(metricStreamRowValues).join(",\n")}`,
    });
  }
  await handle.client.command({ query: "SYSTEM REFRESH VIEW analytics.deduped_sensor" });
  await handle.client.command({ query: "SYSTEM WAIT VIEW analytics.deduped_sensor" });
  await handle.client.command({ query: "SYSTEM REFRESH VIEW analytics.activity_summary" });
  await handle.client.command({ query: "SYSTEM WAIT VIEW analytics.activity_summary" });
}
