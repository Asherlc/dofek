import { randomBytes } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildActivityVo2MaxEstimateTableSql } from "./clickhouse-activity-vo2max-estimate.ts";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

type ClickHouseClient = ReturnType<typeof createClient>;

const userId = "00000000-0000-0000-0000-000000000001";
const groupId = "00000000-0000-0000-0000-000000000100";
const memberId = "00000000-0000-0000-0000-000000000101";
const movedGroupId = "00000000-0000-0000-0000-000000000102";
const unrelatedId = "00000000-0000-0000-0000-000000000999";

describe("activity_vo2max_estimate stable group identity", () => {
  let client: ClickHouseClient | undefined;
  const database = `activity_vo2_group_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    client = createClient({ url: requireClickHouseUrl(), request_timeout: 120_000 });
    await waitForClickHouse(client);
    await seedFixture(client, database);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await client.close();
    }
  });

  it("rekeys a changed raw member to the stable group estimate", async () => {
    const activeClient = requireClient(client);
    await activeClient.command({
      query: `INSERT INTO ${database}.activity_vo2max_estimate ${renderModel(database)}`,
    });

    const result = await activeClient.query({
      query: `SELECT toString(activity_id) AS activity_id, method, vo2max, is_deleted
        FROM ${database}.activity_vo2max_estimate FINAL
        WHERE is_deleted = 0
        ORDER BY activity_id`,
      format: "JSONEachRow",
    });

    expect(
      z
        .array(
          z.object({
            activity_id: z.string(),
            method: z.string(),
            vo2max: z.coerce.number(),
            is_deleted: z.coerce.number(),
          }),
        )
        .parse(await result.json<unknown>()),
    ).toEqual([
      {
        activity_id: groupId,
        method: "cycling_power",
        vo2max: 35.8,
        is_deleted: 0,
      },
    ]);
  }, 120_000);

  it("tombstones and recomputes estimates for a scoped member move without a sample refresh", async () => {
    const activeClient = requireClient(client);
    await seedFixture(activeClient, database);
    await activeClient.command({
      query: `INSERT INTO ${database}.activity_vo2max_estimate ${renderModel(database)}`,
    });
    await activeClient.command({
      query: `INSERT INTO ${database}.deduped_activities VALUES
        ('${groupId}', '${userId}', 'cycling', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'),
         toDateTime64('2026-09-03 15:00:00', 6, 'UTC'), ['${memberId}'], 2, 1,
         toDateTime64('2026-09-03 17:00:00', 9, 'UTC')),
        ('${movedGroupId}', '${userId}', 'cycling', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'),
         toDateTime64('2026-09-03 15:00:00', 6, 'UTC'), ['${memberId}'], 2, 0,
         toDateTime64('2026-09-03 17:00:00', 9, 'UTC'))`,
    });
    await activeClient.command({
      query: `INSERT INTO ${database}.activity_vo2max_estimate ${renderModel(database, [groupId, memberId])}`,
    });

    const result = await activeClient.query({
      query: `SELECT toString(estimate.activity_id) AS activity_id, method, vo2max, is_deleted
        FROM ${database}.activity_vo2max_estimate AS estimate FINAL
        WHERE estimate.activity_id IN (toUUID('${groupId}'), toUUID('${movedGroupId}'))
        ORDER BY estimate.activity_id`,
      format: "JSONEachRow",
    });

    expect(await result.json()).toEqual([
      { activity_id: groupId, method: "cycling_power", vo2max: 0, is_deleted: 1 },
      { activity_id: movedGroupId, method: "cycling_power", vo2max: 35.8, is_deleted: 0 },
    ]);
  }, 120_000);
});

function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) throw new Error("CLICKHOUSE_URL is required for VO2max integration tests");
  return url;
}

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) throw new Error("ClickHouse client was not initialized");
  return client;
}

async function waitForClickHouse(client: ClickHouseClient): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await client.query({ query: "SELECT 1", format: "JSONEachRow" });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ClickHouse did not become ready");
}

async function seedFixture(client: ClickHouseClient, database: string): Promise<void> {
  const statements = [
    `DROP DATABASE IF EXISTS ${database} SYNC`,
    `CREATE DATABASE ${database}`,
    `CREATE TABLE ${database}.deduped_activities (
      activity_id UUID, user_id UUID, canonical_type String,
      started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')),
      member_activity_ids Array(UUID), refresh_version UInt64, is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id)`,
    `CREATE TABLE ${database}.activity (
      id UUID, group_id UUID, _peerdb_synced_at DateTime64(9, 'UTC'))
      ENGINE = ReplacingMergeTree() ORDER BY id`,
    `CREATE TABLE ${database}.activity_sensor_sample (
      activity_id UUID, user_id UUID, recorded_at DateTime64(6, 'UTC'), channel String,
      scalar Nullable(Float64), is_deleted UInt8, refreshed_at DateTime64(9, 'UTC'))
      ENGINE = MergeTree ORDER BY (user_id, activity_id, recorded_at, channel)`,
    `CREATE TABLE ${database}.body_measurement_sample (
      user_id UUID, channel String, _peerdb_synced_at DateTime64(9, 'UTC'))
      ENGINE = ReplacingMergeTree() ORDER BY user_id`,
    `CREATE TABLE ${database}.body_measurement (
      user_id UUID, recorded_at DateTime64(6, 'UTC'), weight_kg Nullable(Float64),
      is_deleted UInt8) ENGINE = ReplacingMergeTree() ORDER BY (user_id, recorded_at)`,
    `CREATE TABLE ${database}.user_profile (
      id UUID, _peerdb_synced_at DateTime64(9, 'UTC'))
      ENGINE = ReplacingMergeTree() ORDER BY id`,
    `CREATE TABLE ${database}.user_profile_current (
      id UUID, max_hr Nullable(Int32)) ENGINE = MergeTree ORDER BY id`,
    `CREATE TABLE ${database}.resting_heart_rate_sleep_window (
      user_id UUID, ended_at Nullable(DateTime64(6, 'UTC')), resting_hr Nullable(Int32),
      is_deleted UInt8, refreshed_at DateTime64(9, 'UTC'))
      ENGINE = ReplacingMergeTree() ORDER BY (user_id, ended_at)
      SETTINGS allow_nullable_key = 1`,
    buildActivityVo2MaxEstimateTableSql().replaceAll("analytics.", `${database}.`),
    `INSERT INTO ${database}.deduped_activities VALUES
      ('${groupId}', '${userId}', 'cycling', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'),
       toDateTime64('2026-09-03 15:00:00', 6, 'UTC'), ['${memberId}'], 1, 0,
       toDateTime64('2026-09-03 16:00:00', 9, 'UTC'))`,
    `INSERT INTO ${database}.activity VALUES
      ('${memberId}', '${groupId}', toDateTime64('2026-09-03 17:00:00', 9, 'UTC'))`,
    `INSERT INTO ${database}.body_measurement VALUES
      ('${userId}', toDateTime64('2026-09-01 12:00:00', 6, 'UTC'), 75, 0)`,
    `INSERT INTO ${database}.activity_sensor_sample
      SELECT '${groupId}', '${userId}',
        addSeconds(toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), toInt64(number)),
        'power', 200, 0, toDateTime64('2026-09-03 15:00:00', 9, 'UTC')
      FROM numbers(301)`,
    `INSERT INTO ${database}.activity_sensor_sample
      SELECT '${movedGroupId}', '${userId}',
        addSeconds(toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), toInt64(number)),
        'power', 200, 0, toDateTime64('2026-09-03 15:00:00', 9, 'UTC')
      FROM numbers(301)`,
    `INSERT INTO ${database}.activity_vo2max_estimate VALUES
      ('${unrelatedId}', '${userId}', toDateTime64('2026-09-02 14:00:00', 6, 'UTC'),
       'cycling_power', 40, 1, 1, toDateTime64('2026-09-03 16:00:00', 9, 'UTC'))`,
  ];
  for (const statement of statements) await client.command({ query: statement });
}

function renderModel(database: string, scopedActivityIds?: readonly string[]): string {
  return renderDbtModelSql(readModelSql("activity_vo2max_estimate.sql"), {
    isIncremental: true,
    activityRefreshScoped: scopedActivityIds != null,
  })
    .replaceAll("{{ initial_lookback_days }}", "365")
    .replaceAll('{{ var("activity_refresh_user_id") }}', userId)
    .replaceAll(
      "{{ activity_refresh_ids() }}",
      `CAST([${(scopedActivityIds ?? []).map((id) => `'${id}'`).join(", ")}], 'Array(UUID)')`,
    )
    .replaceAll("{{ this }}", `${database}.activity_vo2max_estimate`)
    .replace(/\{\{ ref\('([^']+)'\) \}\}/g, `${database}.$1`)
    .replace(/\{\{ source\('[^']+', '([^']+)'\) \}\}/g, `${database}.$1`)
    .concat("\nSETTINGS join_use_nulls = 1, max_threads = 1");
}
