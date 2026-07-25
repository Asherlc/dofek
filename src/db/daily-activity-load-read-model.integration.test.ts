import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const testUserId = "00000000-0000-4000-8000-000000001768";
const testActivityId = "00000000-0000-4000-8000-000000001769";

type ClickHouseClient = ReturnType<typeof createClient>;

const loadRowSchema = z.object({
  daily_load: z.coerce.number(),
});

describe("daily activity-load read-model lifecycle", () => {
  let client: ClickHouseClient | undefined;
  const targetSchema = `analytics_daily_activity_load_test_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    client = createClient({
      url: requireClickHouseUrl(),
      request_timeout: 120_000,
    });
    await waitForClickHouse(client);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${targetSchema} SYNC` });
      await client.close();
    }
  });

  it("updates from the live summary version and tombstones deleted load and strain rows", async () => {
    const activeClient = requireClient(client);
    await seedFixture(activeClient, targetSchema);
    await materializeDailyActivityLoad(activeClient, targetSchema, false);
    await materializeDailyStrain(activeClient, targetSchema, false);

    await expect(readLiveLoad(activeClient, targetSchema)).resolves.toEqual([{ daily_load: 30 }]);
    await expect(readLiveStrainLoad(activeClient, targetSchema)).resolves.toEqual([
      { daily_load: 30 },
    ]);

    await appendActivitySummaryVersion(activeClient, targetSchema, 150, false);
    await materializeDailyActivityLoad(activeClient, targetSchema, true);
    await materializeDailyStrain(activeClient, targetSchema, true);

    await expect(readLiveLoad(activeClient, targetSchema)).resolves.toEqual([{ daily_load: 45 }]);
    await expect(readLiveStrainLoad(activeClient, targetSchema)).resolves.toEqual([
      { daily_load: 45 },
    ]);

    await appendActivitySummaryVersion(activeClient, targetSchema, 150, true);
    await materializeDailyActivityLoad(activeClient, targetSchema, true);
    await materializeDailyStrain(activeClient, targetSchema, true);

    await expect(readLiveLoad(activeClient, targetSchema)).resolves.toEqual([]);
    await expect(readLiveStrainLoad(activeClient, targetSchema)).resolves.toEqual([]);
  }, 180_000);
});

function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) {
    throw new Error("CLICKHOUSE_URL is required for daily activity-load integration tests");
  }
  return url;
}

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) {
    throw new Error("ClickHouse client was not initialized");
  }
  return client;
}

async function waitForClickHouse(client: ClickHouseClient): Promise<void> {
  let lastError: unknown;
  for (let attemptIndex = 0; attemptIndex < 60; attemptIndex += 1) {
    try {
      await client.query({ query: "SELECT 1", format: "JSONEachRow" });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveAfterDelay) => setTimeout(resolveAfterDelay, 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ClickHouse did not become ready");
}

function readModelSql(modelName: "daily_activity_load" | "daily_strain"): string {
  return readFileSync(
    new URL(`../../analytics/models/read_models/${modelName}.sql`, import.meta.url),
    "utf8",
  );
}

function renderModelSelectSql(
  modelName: "daily_activity_load" | "daily_strain",
  targetSchema: string,
  isIncremental: boolean,
): string {
  return readModelSql(modelName)
    .replace(/{{ config\([\s\S]*?\) }}\s*/, "")
    .replace(
      /{% if is_incremental\(\) %}([\s\S]*?)(?:{% else %}([\s\S]*?))?{% endif %}/g,
      (_, incrementalSql: string, initialSql: string | undefined) =>
        isIncremental ? incrementalSql : (initialSql ?? ""),
    )
    .replaceAll("{{ this }}", `${targetSchema}.${modelName}`)
    .replaceAll("{{ ref('activity_summary_rows') }}", `${targetSchema}.activity_summary_rows`)
    .replaceAll("{{ ref('daily_activity_load') }}", `${targetSchema}.daily_activity_load`)
    .concat("\nSETTINGS join_use_nulls = 1, max_threads = 1");
}

async function materializeDailyActivityLoad(
  client: ClickHouseClient,
  targetSchema: string,
  isIncremental: boolean,
): Promise<void> {
  const selectSql = renderModelSelectSql("daily_activity_load", targetSchema, isIncremental);
  const outputColumns = [
    "activity_id",
    "user_id",
    "started_at",
    "ended_at",
    "daily_load",
    ...(selectSql.includes(" AS is_deleted") ? ["is_deleted"] : []),
    "refresh_version",
    "refreshed_at",
  ];

  await client.command({
    query: `INSERT INTO ${targetSchema}.daily_activity_load (${outputColumns.join(", ")})
${selectSql}`,
  });
}

async function materializeDailyStrain(
  client: ClickHouseClient,
  targetSchema: string,
  isIncremental: boolean,
): Promise<void> {
  const selectSql = renderModelSelectSql("daily_strain", targetSchema, isIncremental);
  const outputColumns = [
    "user_id",
    "date",
    "daily_load",
    "strain",
    "acute_load_7d",
    "chronic_load_28d",
    "workload_ratio",
    ...(selectSql.includes(" AS is_deleted") ? ["is_deleted"] : []),
    "refresh_version",
    "refreshed_at",
  ];

  await client.command({
    query: `INSERT INTO ${targetSchema}.daily_strain (${outputColumns.join(", ")})
${selectSql}`,
  });
}

async function readLiveLoad(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<z.infer<typeof loadRowSchema>[]> {
  const result = await client.query({
    query: `SELECT daily_load
      FROM ${targetSchema}.daily_activity_load FINAL
      WHERE user_id = {userId:UUID}
        AND activity_id = {activityId:UUID}
        AND is_deleted = 0`,
    query_params: {
      activityId: testActivityId,
      userId: testUserId,
    },
    format: "JSONEachRow",
  });
  return z.array(loadRowSchema).parse(await result.json<unknown>());
}

async function readLiveStrainLoad(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<z.infer<typeof loadRowSchema>[]> {
  const result = await client.query({
    query: `SELECT daily_load
      FROM ${targetSchema}.daily_strain FINAL
      WHERE user_id = {userId:UUID}
        AND date = today()
        AND is_deleted = 0`,
    query_params: {
      userId: testUserId,
    },
    format: "JSONEachRow",
  });
  return z.array(loadRowSchema).parse(await result.json<unknown>());
}

async function seedFixture(client: ClickHouseClient, targetSchema: string): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${targetSchema} SYNC`,
    `CREATE DATABASE ${targetSchema}`,
    createActivitySummaryRowsTableSql(targetSchema),
    createDailyActivityLoadTableSql(targetSchema),
    createDailyStrainTableSql(targetSchema),
  ]);
  await appendActivitySummaryVersion(client, targetSchema, 100, false);
}

async function runStatements(client: ClickHouseClient, statements: string[]): Promise<void> {
  for (const [statementIndex, statement] of statements.entries()) {
    try {
      await client.command({ query: statement });
    } catch (error) {
      const statementPreview = statement.replace(/\s+/g, " ").slice(0, 240);
      throw new Error(
        `ClickHouse fixture statement ${statementIndex + 1} failed: ${statementPreview}`,
        { cause: error },
      );
    }
  }
}

function createActivitySummaryRowsTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.activity_summary_rows (
  activity_id UUID,
  user_id UUID,
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  avg_hr Nullable(Float64),
  max_hr Nullable(Int32),
  is_deleted UInt8,
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`;
}

function createDailyActivityLoadTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.daily_activity_load (
  activity_id UUID,
  user_id UUID,
  started_at Nullable(DateTime64(6, 'UTC')),
  ended_at Nullable(DateTime64(6, 'UTC')),
  daily_load Nullable(Float64),
  is_deleted UInt8 DEFAULT 0,
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`;
}

function createDailyStrainTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.daily_strain (
  user_id UUID,
  date Date,
  daily_load Float64,
  strain Float64,
  acute_load_7d Float64,
  chronic_load_28d Float64,
  workload_ratio Nullable(Float64),
  is_deleted UInt8 DEFAULT 0,
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, date)`;
}

async function appendActivitySummaryVersion(
  client: ClickHouseClient,
  targetSchema: string,
  averageHeartRate: number,
  isDeleted: boolean,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${targetSchema}.activity_summary_rows
      SELECT
        {activityId:UUID},
        {userId:UUID},
        toDateTime64(today(), 6, 'UTC'),
        toDateTime64(today(), 6, 'UTC') + INTERVAL 1 HOUR,
        {averageHeartRate:Float64},
        200,
        {isDeleted:UInt8},
        toUInt64(toUnixTimestamp64Nano(now64(9))),
        now64(9)`,
    query_params: {
      activityId: testActivityId,
      averageHeartRate,
      isDeleted: isDeleted ? 1 : 0,
      userId: testUserId,
    },
  });
}
