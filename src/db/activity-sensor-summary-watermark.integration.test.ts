import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildActivitySensorSummaryRowsTableSql } from "./clickhouse-activity-sensor-summary.ts";

const historicalActivityId = "00000000-0000-0000-0000-000000000901";
const unrelatedActivityId = "00000000-0000-0000-0000-000000000902";
const testUserId = "00000000-0000-0000-0000-000000000001";

type ClickHouseClient = ReturnType<typeof createClient>;

interface SensorSummaryResultRow {
  activity_id: string;
  avg_power: number | null;
  power_sample_count: number;
}

describe("activity_sensor_summary_rows historical dirty keys", () => {
  let client: ClickHouseClient | undefined;
  const targetSchema = `analytics_activity_sensor_summary_test_${randomBytes(6).toString("hex")}`;

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

  it("summarizes historical samples even after an unrelated row advanced the table watermark", async () => {
    const activeClient = requireClient(client);
    await seedHistoricalBackfillFixture(activeClient, targetSchema);

    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.activity_sensor_summary_rows
${renderActivitySensorSummaryRowsSelectSql(targetSchema)}`,
    });

    const result = await activeClient.query({
      query: `SELECT
          toString(activity_id) AS activity_id,
          avg_power,
          toUInt32(ifNull(power_sample_count, 0)) AS power_sample_count
        FROM ${targetSchema}.activity_sensor_summary_rows FINAL
        WHERE is_deleted = 0
          AND activity_id = '${historicalActivityId}'`,
      format: "JSONEachRow",
    });
    const rows = await result.json<SensorSummaryResultRow>();

    expect(rows).toEqual([
      {
        activity_id: historicalActivityId,
        avg_power: 210,
        power_sample_count: 2,
      },
    ]);
  }, 180_000);
});

function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) {
    throw new Error("CLICKHOUSE_URL is required for activity sensor summary integration tests");
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

function readProjectFile(relativePath: string): string {
  return readFileSync(join(import.meta.dirname, "../..", relativePath), "utf8");
}

function renderActivitySensorSummaryRowsSelectSql(targetSchema: string): string {
  return readProjectFile("analytics/models/read_models/activity_sensor_summary_rows.sql")
    .replace(/{{ config\([\s\S]*?\) }}\s*/, "")
    .replace(/\{% set initial_lookback_days = var\('initial_lookback_days', 120\) %\}/g, "")
    .replace(
      /\{% if is_incremental\(\) %}\s*(target_state AS \([\s\S]*?\),)\s*\{% endif %\}/g,
      "$1",
    )
    .replace(/\{% if is_incremental\(\) %}\s*([\s\S]*?)\s*\{% else %}[\s\S]*?\{% endif %}/g, "$1")
    .replace(/\{% if is_incremental\(\) %}\s*([\s\S]*?)\s*\{% endif %}/g, "$1")
    .replace(/{{ initial_lookback_days }}/g, "120")
    .replace(/{{ this }}/g, `${targetSchema}.activity_sensor_summary_rows`)
    .replace(/{{ ref\('activity_sensor_sample'\) }}/g, `${targetSchema}.activity_sensor_sample`)
    .replace(/{{ source\('postgres_fitness', 'activity'\) }}/g, `${targetSchema}.source_activity`);
}

async function seedHistoricalBackfillFixture(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${targetSchema} SYNC`,
    `CREATE DATABASE ${targetSchema}`,
    createSourceActivityTableSql(targetSchema),
    createActivitySensorSampleTableSql(targetSchema),
    buildActivitySensorSummaryRowsTableSql().replaceAll("analytics.", `${targetSchema}.`),
    insertCurrentActivitiesSql(targetSchema),
    insertHistoricalPowerSamplesSql(targetSchema),
    insertUnrelatedFreshSummarySql(targetSchema),
  ]);
}

async function runStatements(client: ClickHouseClient, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await client.command({ query: statement });
  }
}

function createSourceActivityTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.source_activity (
  id UUID,
  user_id UUID,
  started_at DateTime64(6, 'UTC'),
  provider_absent_at Nullable(DateTime64(6, 'UTC')),
  deleted_at Nullable(DateTime64(6, 'UTC')),
  _peerdb_is_deleted UInt8
)
ENGINE = ReplacingMergeTree()
ORDER BY id`;
}

function createActivitySensorSampleTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.activity_sensor_sample (
  activity_id UUID,
  user_id UUID,
  recorded_at DateTime64(6, 'UTC'),
  recorded_date Date,
  channel String,
  scalar Nullable(Float64),
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id, recorded_date, channel, recorded_at)`;
}

function insertCurrentActivitiesSql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.source_activity VALUES
  ('${historicalActivityId}', '${testUserId}', toDateTime64('2019-07-16 14:56:37', 6, 'UTC'), NULL, NULL, 0),
  ('${unrelatedActivityId}', '${testUserId}', toDateTime64('2026-07-04 01:00:00', 6, 'UTC'), NULL, NULL, 0)`;
}

function insertHistoricalPowerSamplesSql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.activity_sensor_sample VALUES
  ('${historicalActivityId}', '${testUserId}', toDateTime64('2019-07-16 14:56:37', 6, 'UTC'), toDate('2019-07-16'), 'power', 200.0, 100, 0, toDateTime64('2026-07-10 05:31:41', 9, 'UTC')),
  ('${historicalActivityId}', '${testUserId}', toDateTime64('2019-07-16 14:56:38', 6, 'UTC'), toDate('2019-07-16'), 'power', 220.0, 100, 0, toDateTime64('2026-07-10 05:31:41', 9, 'UTC'))`;
}

function insertUnrelatedFreshSummarySql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.activity_sensor_summary_rows (
    activity_id,
    user_id,
    sample_count,
    refresh_version,
    is_deleted,
    refreshed_at
  ) VALUES (
    '${unrelatedActivityId}',
    '${testUserId}',
    1,
    200,
    0,
    toDateTime64('2026-07-10 15:00:00', 9, 'UTC')
  )`;
}
