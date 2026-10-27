import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

type ClickHouseClient = ReturnType<typeof createClient>;

const targetSchema = "activity_power_curve_final_scope_test";
const testUserId = "00000000-0000-0000-0000-0000000000aa";
const controlActivityId = "00000000-0000-0000-0000-0000000000c1";
const deletedLatestActivityId = "00000000-0000-0000-0000-0000000000c2";

const powerCurveRowsSchema = z.array(
  z.object({
    activity_id: z.string(),
    duration_seconds: z.number().int(),
    best_power: z.number().int().nullable(),
  }),
);

describe("activity_power_curve read model", () => {
  let client: ClickHouseClient | undefined;

  beforeAll(async () => {
    client = createClient({
      url: requireClickHouseUrl(),
      request_timeout: 30_000,
    });
    await waitForClickHouse(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${targetSchema} SYNC` });
    }
    await client?.close();
  });

  it("scopes FINAL to power rows without resurrecting deleted latest versions", async () => {
    const seededClient = requireClient(client);
    await seedFixture(seededClient);

    await runStatements(seededClient, [
      `INSERT INTO ${targetSchema}.activity_power_curve\n${renderActivityPowerCurveSelectSql(targetSchema)}`,
    ]);

    const result = await seededClient.query({
      query: `SELECT
          toString(activity_id) AS activity_id,
          duration_seconds,
          best_power
        FROM ${targetSchema}.activity_power_curve FINAL
        WHERE is_deleted = 0
        ORDER BY activity_id, duration_seconds`,
      format: "JSONEachRow",
    });

    expect(powerCurveRowsSchema.parse(await result.json())).toEqual([
      { activity_id: controlActivityId, duration_seconds: 1, best_power: 100 },
    ]);
  });
});

function renderActivityPowerCurveSelectSql(schema: string): string {
  return renderDbtModelSql(readModelSql("activity_power_curve.sql"), {
    isIncremental: false,
  })
    .replaceAll("{{ ref('activity_summary_rows') }}", `${schema}.activity_summary_rows`)
    .replaceAll("{{ ref('activity_sensor_sample') }}", `${schema}.activity_sensor_sample`)
    .replaceAll("{{ this }}", `${schema}.activity_power_curve`)
    .concat("\nSETTINGS join_use_nulls = 1");
}

async function seedFixture(client: ClickHouseClient): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${targetSchema} SYNC`,
    `CREATE DATABASE ${targetSchema}`,
    createActivitySummaryRowsTableSql(targetSchema),
    createActivitySensorSampleTableSql(targetSchema),
    createActivityPowerCurveTableSql(targetSchema),
    insertActivitiesSql(targetSchema),
    insertControlSamplesSql(targetSchema),
    insertDeletedLatestSamplesSql(targetSchema),
  ]);
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

function createActivitySummaryRowsTableSql(schema: string): string {
  return `CREATE TABLE ${schema}.activity_summary_rows (
  activity_id UUID,
  user_id UUID,
  canonical_type String,
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  is_deleted UInt8,
  power_sample_count UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree()
ORDER BY (user_id, activity_id)`;
}

function createActivitySensorSampleTableSql(schema: string): string {
  return `CREATE TABLE ${schema}.activity_sensor_sample (
  activity_id UUID,
  user_id UUID,
  recorded_at DateTime64(6, 'UTC'),
  recorded_date Date,
  channel LowCardinality(String),
  scalar Nullable(Float64),
  provider_id Nullable(String),
  device_id Nullable(String),
  measurement_kind LowCardinality(String) DEFAULT 'unknown',
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id, recorded_date, channel, recorded_at)`;
}

function createActivityPowerCurveTableSql(schema: string): string {
  return `CREATE TABLE ${schema}.activity_power_curve (
  activity_id UUID,
  user_id UUID,
  started_at Nullable(DateTime64(6, 'UTC')),
  activity_date Nullable(String),
  duration_seconds Int32,
  best_power Nullable(Int32),
  start_offset_seconds Nullable(Float64),
  observed_samples Nullable(UInt64),
  median_sample_interval_seconds Nullable(Float64),
  largest_gap_seconds Nullable(Float64),
  coverage_pct Nullable(Float64),
  power_measurement_kind Nullable(String),
  source_providers Array(String),
  source_devices Array(String),
  is_deleted UInt8,
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id, duration_seconds)`;
}

function insertActivitiesSql(schema: string): string {
  return `INSERT INTO ${schema}.activity_summary_rows (
  activity_id, user_id, canonical_type, started_at, ended_at, is_deleted, power_sample_count, refreshed_at
) VALUES
  ('${controlActivityId}', '${testUserId}', 'cycling', toDateTime64('2026-07-01 15:00:00', 6, 'UTC'), toDateTime64('2026-07-01 15:01:00', 6, 'UTC'), 0, 2, toDateTime64('2026-07-10 05:00:00', 9, 'UTC')),
  ('${deletedLatestActivityId}', '${testUserId}', 'cycling', toDateTime64('2026-07-01 16:00:00', 6, 'UTC'), toDateTime64('2026-07-01 16:01:00', 6, 'UTC'), 0, 2, toDateTime64('2026-07-10 05:00:00', 9, 'UTC'))`;
}

function insertControlSamplesSql(schema: string): string {
  return `INSERT INTO ${schema}.activity_sensor_sample (
  activity_id, user_id, recorded_at, recorded_date, channel, scalar, refresh_version, is_deleted, refreshed_at
) VALUES
  ('${controlActivityId}', '${testUserId}', toDateTime64('2026-07-01 15:00:00', 6, 'UTC'), toDate('2026-07-01'), 'power', 100.0, 1, 0, toDateTime64('2026-07-10 05:00:00', 9, 'UTC')),
  ('${controlActivityId}', '${testUserId}', toDateTime64('2026-07-01 15:00:01', 6, 'UTC'), toDate('2026-07-01'), 'power', 100.0, 1, 0, toDateTime64('2026-07-10 05:00:00', 9, 'UTC')),
  ('${controlActivityId}', '${testUserId}', toDateTime64('2026-07-01 15:00:00', 6, 'UTC'), toDate('2026-07-01'), 'heart_rate', 999.0, 1, 0, toDateTime64('2026-07-10 05:00:00', 9, 'UTC')),
  ('${controlActivityId}', '${testUserId}', toDateTime64('2026-07-01 15:00:02', 6, 'UTC'), toDate('2026-07-01'), 'power', -50.0, 1, 0, toDateTime64('2026-07-10 05:00:00', 9, 'UTC'))`;
}

function insertDeletedLatestSamplesSql(schema: string): string {
  return `INSERT INTO ${schema}.activity_sensor_sample (
  activity_id, user_id, recorded_at, recorded_date, channel, scalar, refresh_version, is_deleted, refreshed_at
) VALUES
  ('${deletedLatestActivityId}', '${testUserId}', toDateTime64('2026-07-01 16:00:00', 6, 'UTC'), toDate('2026-07-01'), 'power', 900.0, 1, 0, toDateTime64('2026-07-10 05:00:00', 9, 'UTC')),
  ('${deletedLatestActivityId}', '${testUserId}', toDateTime64('2026-07-01 16:00:00', 6, 'UTC'), toDate('2026-07-01'), 'power', 900.0, 2, 1, toDateTime64('2026-07-10 05:00:00', 9, 'UTC')),
  ('${deletedLatestActivityId}', '${testUserId}', toDateTime64('2026-07-01 16:00:01', 6, 'UTC'), toDate('2026-07-01'), 'power', 900.0, 1, 0, toDateTime64('2026-07-10 05:00:00', 9, 'UTC'))`;
}

function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) {
    throw new Error("CLICKHOUSE_URL is required for activity power curve integration tests");
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
  for (let attemptIndex = 0; attemptIndex < 30; attemptIndex += 1) {
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
