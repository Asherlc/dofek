import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const testUserId = "00000000-0000-4000-8000-000000001769";
const historicalMeasurementId = "00000000-0000-4000-8000-000000001770";
const recentMeasurementId = "00000000-0000-4000-8000-000000001771";
const laggedMeasurementId = "00000000-0000-4000-8000-000000001772";

type ClickHouseClient = ReturnType<typeof createClient>;

const measurementRowSchema = z.object({
  weight_kg: z.coerce.number(),
});

describe("daily_body_measurement read-model lifecycle", () => {
  let client: ClickHouseClient | undefined;
  const targetSchema = `analytics_daily_body_test_${randomBytes(6).toString("hex")}`;

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

  it("updates and tombstones historical measurements from source change timestamps", async () => {
    const activeClient = requireClient(client);
    await seedFixture(activeClient, targetSchema);
    await materializeDailyBodyMeasurement(activeClient, targetSchema, false);

    await expect(readHistoricalMeasurement(activeClient, targetSchema)).resolves.toEqual([
      { weight_kg: 80 },
    ]);

    await appendHistoricalVersion(activeClient, targetSchema, 75, false, 2, "2026-02-01 00:00:00");
    await materializeDailyBodyMeasurement(activeClient, targetSchema, true);

    await expect(readHistoricalMeasurement(activeClient, targetSchema)).resolves.toEqual([
      { weight_kg: 75 },
    ]);

    await appendHistoricalVersion(activeClient, targetSchema, 75, true, 3, "2026-02-02 00:00:00");
    await materializeDailyBodyMeasurement(activeClient, targetSchema, true);

    await expect(readHistoricalMeasurement(activeClient, targetSchema)).resolves.toEqual([]);
    await expect(readHistoricalTombstone(activeClient, targetSchema)).resolves.toBe(1);
  }, 180_000);

  it("processes a historical measurement after the upstream body model refreshes", async () => {
    const activeClient = requireClient(client);
    await seedFixture(activeClient, targetSchema);
    await materializeDailyBodyMeasurement(activeClient, targetSchema, false);
    await appendLaggedMeasurement(activeClient, targetSchema, "2026-02-03 00:00:00");

    await materializeDailyBodyMeasurement(activeClient, targetSchema, true);

    await expect(readMeasurement(activeClient, targetSchema, laggedMeasurementId)).resolves.toEqual(
      [{ weight_kg: 70 }],
    );
  }, 180_000);
});

function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) {
    throw new Error("CLICKHOUSE_URL is required for daily body measurement integration tests");
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

function readModelSql(): string {
  return readFileSync(
    new URL("../../analytics/models/read_models/daily_body_measurement.sql", import.meta.url),
    "utf8",
  );
}

function renderModelSelectSql(targetSchema: string, isIncremental: boolean): string {
  return readModelSql()
    .replace(/{{ config\([\s\S]*?\) }}\s*/, "")
    .replace(
      /{% if is_incremental\(\) %}([\s\S]*?)(?:{% else %}([\s\S]*?))?{% endif %}/g,
      (_, incrementalSql: string, initialSql: string | undefined) =>
        isIncremental ? incrementalSql : (initialSql ?? ""),
    )
    .replaceAll("{{ this }}", `${targetSchema}.daily_body_measurement`)
    .replaceAll("{{ ref('body_measurement') }}", `${targetSchema}.body_measurement`)
    .concat("\nSETTINGS join_use_nulls = 1, max_threads = 1");
}

async function materializeDailyBodyMeasurement(
  client: ClickHouseClient,
  targetSchema: string,
  isIncremental: boolean,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${targetSchema}.daily_body_measurement (
      measurement_id, user_id, date, recorded_at, weight_kg, body_fat_pct,
      is_deleted, source_synced_at, refresh_version, refreshed_at
    )
${renderModelSelectSql(targetSchema, isIncremental)}`,
  });
}

async function readHistoricalMeasurement(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<z.infer<typeof measurementRowSchema>[]> {
  const result = await client.query({
    query: `SELECT weight_kg
      FROM ${targetSchema}.daily_body_measurement FINAL
      WHERE measurement_id = {measurementId:UUID}
        AND is_deleted = 0`,
    query_params: { measurementId: historicalMeasurementId },
    format: "JSONEachRow",
  });
  return z.array(measurementRowSchema).parse(await result.json<unknown>());
}

async function readMeasurement(
  client: ClickHouseClient,
  targetSchema: string,
  measurementId: string,
): Promise<z.infer<typeof measurementRowSchema>[]> {
  const result = await client.query({
    query: `SELECT weight_kg
      FROM ${targetSchema}.daily_body_measurement FINAL
      WHERE measurement_id = {measurementId:UUID}
        AND is_deleted = 0`,
    query_params: { measurementId },
    format: "JSONEachRow",
  });
  return z.array(measurementRowSchema).parse(await result.json<unknown>());
}

async function readHistoricalTombstone(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<number> {
  const result = await client.query({
    query: `SELECT is_deleted
      FROM ${targetSchema}.daily_body_measurement FINAL
      WHERE measurement_id = {measurementId:UUID}`,
    query_params: { measurementId: historicalMeasurementId },
    format: "JSONEachRow",
  });
  const rows = z.array(z.object({ is_deleted: z.coerce.number() })).parse(await result.json());
  return rows[0]?.is_deleted ?? 0;
}

async function seedFixture(client: ClickHouseClient, targetSchema: string): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${targetSchema} SYNC`,
    `CREATE DATABASE ${targetSchema}`,
    createSourceTableSql(targetSchema),
    createDailyBodyTableSql(targetSchema),
  ]);
  await appendHistoricalVersion(client, targetSchema, 80, false, 1, "2026-01-02 00:00:00");
  await client.command({
    query: `INSERT INTO ${targetSchema}.body_measurement VALUES (
      '${recentMeasurementId}',
      '${testUserId}',
      toDateTime64('2026-01-20 08:00:00', 6, 'UTC'),
      82,
      20,
      0,
      1,
      toDateTime64('2026-01-20 09:00:00', 9, 'UTC')
    )`,
  });
}

async function appendHistoricalVersion(
  client: ClickHouseClient,
  targetSchema: string,
  weightKg: number,
  isDeleted: boolean,
  version: number,
  sourceSyncedAt: string,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${targetSchema}.body_measurement VALUES (
      '${historicalMeasurementId}',
      '${testUserId}',
      toDateTime64('2026-01-01 08:00:00', 6, 'UTC'),
      ${weightKg},
      21,
      ${isDeleted ? 1 : 0},
      ${version},
      toDateTime64('${sourceSyncedAt}', 9, 'UTC')
    )`,
  });
}

async function appendLaggedMeasurement(
  client: ClickHouseClient,
  targetSchema: string,
  sourceSyncedAt: string,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${targetSchema}.body_measurement VALUES (
      '${laggedMeasurementId}',
      '${testUserId}',
      toDateTime64('2026-01-25 08:00:00', 6, 'UTC'),
      70,
      19,
      0,
      1,
      toDateTime64({sourceSyncedAt:String}, 9, 'UTC')
    )`,
    query_params: { sourceSyncedAt },
  });
}

async function runStatements(client: ClickHouseClient, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await client.command({ query: statement });
  }
}

function createSourceTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.body_measurement (
    id UUID,
    user_id UUID,
    recorded_at DateTime64(6, 'UTC'),
    weight_kg Nullable(Float64),
    body_fat_pct Nullable(Float64),
    is_deleted UInt8,
    refresh_version UInt64,
    refreshed_at DateTime64(9, 'UTC')
  )
  ENGINE = ReplacingMergeTree(refresh_version)
  ORDER BY (user_id, id)`;
}

function createDailyBodyTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.daily_body_measurement (
    measurement_id UUID,
    user_id UUID,
    date Date,
    recorded_at DateTime64(6, 'UTC'),
    weight_kg Nullable(Float64),
    body_fat_pct Nullable(Float64),
    is_deleted UInt8,
    source_synced_at DateTime64(9, 'UTC'),
    refresh_version UInt64,
    refreshed_at DateTime64(9, 'UTC'),
    INDEX refreshed_at_minmax refreshed_at TYPE minmax GRANULARITY 1
  )
  ENGINE = ReplacingMergeTree(refresh_version)
  ORDER BY (user_id, measurement_id)`;
}
