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
const weeklyWeightRowSchema = z.object({
  weight_kg: z.coerce.number().nullable(),
});
const viewRefreshStateSchema = z.object({
  last_refresh_time: z.string(),
  last_success_time: z.string(),
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
    await refreshBodyView(activeClient, targetSchema);
    await materializeDailyBodyMeasurement(activeClient, targetSchema, false);
    await materializeWeeklyHealthspan(activeClient, targetSchema, false);

    await expect(readHistoricalMeasurement(activeClient, targetSchema)).resolves.toEqual([
      { weight_kg: 80 },
    ]);
    await expect(readWeeklyWeight(activeClient, targetSchema)).resolves.toEqual([
      { weight_kg: 80 },
    ]);

    await appendHistoricalVersion(activeClient, targetSchema, 75, false, 2, "2026-02-01 00:00:00");
    await refreshBodyView(activeClient, targetSchema);
    await materializeDailyBodyMeasurement(activeClient, targetSchema, true);
    await materializeWeeklyHealthspan(activeClient, targetSchema, true);

    await expect(readHistoricalMeasurement(activeClient, targetSchema)).resolves.toEqual([
      { weight_kg: 75 },
    ]);
    await expect(readWeeklyWeight(activeClient, targetSchema)).resolves.toEqual([
      { weight_kg: 75 },
    ]);

    await appendHistoricalVersion(activeClient, targetSchema, 75, true, 3, "2026-02-02 00:00:00");
    await refreshBodyView(activeClient, targetSchema);
    await materializeDailyBodyMeasurement(activeClient, targetSchema, true);
    await materializeWeeklyHealthspan(activeClient, targetSchema, true);

    await expect(readHistoricalMeasurement(activeClient, targetSchema)).resolves.toEqual([]);
    await expect(readHistoricalTombstone(activeClient, targetSchema)).resolves.toBe(1);
    await expect(readWeeklyWeight(activeClient, targetSchema)).resolves.toEqual([
      { weight_kg: null },
    ]);
  }, 180_000);

  it("does not advance the source watermark past the successful body view snapshot", async () => {
    const activeClient = requireClient(client);
    await seedFixture(activeClient, targetSchema);
    await refreshBodyView(activeClient, targetSchema);
    await materializeDailyBodyMeasurement(activeClient, targetSchema, false);
    const refreshState = await readBodyViewRefreshState(activeClient, targetSchema);

    expect(Date.parse(`${refreshState.last_refresh_time}Z`)).toBeGreaterThan(
      Date.parse(`${refreshState.last_success_time}Z`),
    );
    await appendLaggedMeasurement(activeClient, targetSchema, refreshState.last_refresh_time);

    await materializeDailyBodyMeasurement(activeClient, targetSchema, true);
    await refreshBodyView(activeClient, targetSchema);
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

function weeklyHealthspanModelSql(): string {
  return readFileSync(
    new URL("../../analytics/models/read_models/weekly_healthspan.sql", import.meta.url),
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
    .replaceAll("analytics.body_measurement_sample", `${targetSchema}.body_measurement_sample`)
    .replaceAll("analytics.v_body_measurement", `${targetSchema}.v_body_measurement`)
    .replaceAll("database = 'analytics'", `database = '${targetSchema}'`)
    .concat("\nSETTINGS join_use_nulls = 1, max_threads = 1");
}

function renderWeeklyHealthspanSelectSql(targetSchema: string, isIncremental: boolean): string {
  return weeklyHealthspanModelSql()
    .replace(/{{ config\([\s\S]*?\) }}\s*/, "")
    .replace(
      /{% if is_incremental\(\) %}([\s\S]*?)(?:{% else %}([\s\S]*?))?{% endif %}/g,
      (_, incrementalSql: string, initialSql: string | undefined) =>
        isIncremental ? incrementalSql : (initialSql ?? ""),
    )
    .replaceAll("{{ this }}", `${targetSchema}.weekly_healthspan`)
    .replaceAll("analytics.v_sleep", `${targetSchema}.v_sleep`)
    .replaceAll("analytics.v_daily_metrics", `${targetSchema}.v_daily_metrics`)
    .replaceAll(
      "{{ ref('resting_heart_rate_sleep_window') }}",
      `${targetSchema}.resting_heart_rate_sleep_window`,
    )
    .replaceAll(
      "{{ ref('healthspan_activity_zone_minutes') }}",
      `${targetSchema}.healthspan_activity_zone_minutes`,
    )
    .replaceAll("{{ ref('deduped_activities') }}", `${targetSchema}.deduped_activities`)
    .replaceAll("{{ ref('activity_vo2max_estimate') }}", `${targetSchema}.activity_vo2max_estimate`)
    .replaceAll("{{ ref('daily_body_measurement') }}", `${targetSchema}.daily_body_measurement`)
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

async function materializeWeeklyHealthspan(
  client: ClickHouseClient,
  targetSchema: string,
  isIncremental: boolean,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${targetSchema}.weekly_healthspan (
      user_id, week_start, avg_sleep_min, bedtime_stddev_min, avg_resting_hr,
      avg_steps, latest_vo2max, weekly_aerobic_min, weekly_high_intensity_min,
      sessions_per_week, weight_kg, body_fat_pct, refresh_version, refreshed_at
    )
${renderWeeklyHealthspanSelectSql(targetSchema, isIncremental)}`,
  });
}

async function refreshBodyView(client: ClickHouseClient, targetSchema: string): Promise<void> {
  await client.command({ query: `SYSTEM REFRESH VIEW ${targetSchema}.v_body_measurement` });
  await client.command({ query: `SYSTEM WAIT VIEW ${targetSchema}.v_body_measurement` });
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

async function readBodyViewRefreshState(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<z.infer<typeof viewRefreshStateSchema>> {
  const result = await client.query({
    query: `SELECT
        toString(last_refresh_time) AS last_refresh_time,
        toString(last_success_time) AS last_success_time
      FROM system.view_refreshes
      WHERE database = {database:String}
        AND view = 'v_body_measurement'`,
    query_params: { database: targetSchema },
    format: "JSONEachRow",
  });
  return viewRefreshStateSchema.parse((await result.json<unknown>())[0]);
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

async function readWeeklyWeight(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<z.infer<typeof weeklyWeightRowSchema>[]> {
  const result = await client.query({
    query: `SELECT weight_kg
      FROM ${targetSchema}.weekly_healthspan FINAL
      WHERE user_id = {userId:UUID}
        AND week_start = toMonday(toDate('2026-01-01'))`,
    query_params: { userId: testUserId },
    format: "JSONEachRow",
  });
  return z.array(weeklyWeightRowSchema).parse(await result.json<unknown>());
}

async function seedFixture(client: ClickHouseClient, targetSchema: string): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${targetSchema} SYNC`,
    `CREATE DATABASE ${targetSchema}`,
    createSourceTableSql(targetSchema),
    createBodyViewSql(targetSchema),
    createDailyBodyTableSql(targetSchema),
    ...createWeeklyHealthspanDependencyTablesSql(targetSchema),
    createWeeklyHealthspanTableSql(targetSchema),
  ]);
  await appendHistoricalVersion(client, targetSchema, 80, false, 1, "2026-01-02 00:00:00");
  await client.command({
    query: `INSERT INTO ${targetSchema}.body_measurement_sample VALUES (
      '${recentMeasurementId}',
      '${testUserId}',
      toDateTime64('2026-01-20 08:00:00', 6, 'UTC'),
      82,
      20,
      toDateTime64('2026-01-20 09:00:00', 9, 'UTC'),
      0,
      1
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
    query: `INSERT INTO ${targetSchema}.body_measurement_sample VALUES (
      '${historicalMeasurementId}',
      '${testUserId}',
      toDateTime64('2026-01-01 08:00:00', 6, 'UTC'),
      ${weightKg},
      21,
      toDateTime64('${sourceSyncedAt}', 9, 'UTC'),
      ${isDeleted ? 1 : 0},
      ${version}
    )`,
  });
}

async function appendLaggedMeasurement(
  client: ClickHouseClient,
  targetSchema: string,
  sourceSyncedAt: string,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${targetSchema}.body_measurement_sample VALUES (
      '${laggedMeasurementId}',
      '${testUserId}',
      toDateTime64('2026-01-25 08:00:00', 6, 'UTC'),
      70,
      19,
      toDateTime64({sourceSyncedAt:String}, 9, 'UTC'),
      0,
      1
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
  return `CREATE TABLE ${targetSchema}.body_measurement_sample (
    id UUID,
    user_id UUID,
    recorded_at DateTime64(6, 'UTC'),
    weight_kg Nullable(Float64),
    body_fat_pct Nullable(Float64),
    _peerdb_synced_at DateTime64(9, 'UTC'),
    _peerdb_is_deleted UInt8,
    _peerdb_version UInt64
  )
  ENGINE = ReplacingMergeTree(_peerdb_version)
  ORDER BY (user_id, id)`;
}

function createBodyViewSql(targetSchema: string): string {
  return `CREATE MATERIALIZED VIEW ${targetSchema}.v_body_measurement
    REFRESH EVERY 1 HOUR
    ENGINE = MergeTree
    ORDER BY (user_id, recorded_at)
    AS SELECT
      id,
      user_id,
      recorded_at,
      weight_kg,
      body_fat_pct,
      sleep(1) AS refresh_delay
    FROM ${targetSchema}.body_measurement_sample FINAL
    WHERE _peerdb_is_deleted = 0`;
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

function createWeeklyHealthspanDependencyTablesSql(targetSchema: string): string[] {
  return [
    `CREATE TABLE ${targetSchema}.v_sleep (
      user_id UUID,
      started_at DateTime64(6, 'UTC'),
      duration_minutes Float64,
      is_nap Bool
    ) ENGINE = MergeTree ORDER BY (user_id, started_at)`,
    `CREATE TABLE ${targetSchema}.resting_heart_rate_sleep_window (
      user_id UUID,
      ended_at Nullable(DateTime64(6, 'UTC')),
      resting_hr Nullable(Float64),
      is_deleted UInt8,
      refresh_version UInt64
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY user_id`,
    `CREATE TABLE ${targetSchema}.v_daily_metrics (
      user_id UUID,
      date Date,
      steps Nullable(Float64),
      exercise_minutes Nullable(Float64)
    ) ENGINE = MergeTree ORDER BY (user_id, date)`,
    `CREATE TABLE ${targetSchema}.healthspan_activity_zone_minutes (
      user_id UUID,
      started_at Nullable(DateTime64(6, 'UTC')),
      aerobic_minutes Float64,
      high_intensity_minutes Float64,
      is_deleted UInt8,
      refresh_version UInt64
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY user_id`,
    `CREATE TABLE ${targetSchema}.deduped_activities (
      user_id UUID,
      started_at Nullable(DateTime64(6, 'UTC')),
      activity_type String,
      is_deleted UInt8,
      refresh_version UInt64
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY user_id`,
    `CREATE TABLE ${targetSchema}.activity_vo2max_estimate (
      user_id UUID,
      started_at DateTime64(6, 'UTC'),
      vo2max Float64,
      is_deleted UInt8,
      refresh_version UInt64
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, started_at)`,
  ];
}

function createWeeklyHealthspanTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.weekly_healthspan (
    user_id UUID,
    week_start Date,
    avg_sleep_min Nullable(Float64),
    bedtime_stddev_min Nullable(Float64),
    avg_resting_hr Nullable(Float64),
    avg_steps Nullable(Float64),
    latest_vo2max Nullable(Float64),
    weekly_aerobic_min Float64,
    weekly_high_intensity_min Float64,
    sessions_per_week Nullable(Float64),
    weight_kg Nullable(Float64),
    body_fat_pct Nullable(Float64),
    refresh_version UInt64,
    refreshed_at DateTime64(9, 'UTC')
  )
  ENGINE = ReplacingMergeTree(refresh_version)
  ORDER BY (user_id, week_start)`;
}
