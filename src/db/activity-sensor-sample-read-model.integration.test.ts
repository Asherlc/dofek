import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

type ClickHouseClient = ReturnType<typeof createClient>;

const activitySensorSampleRowSchema = z.object({
  activity_id: z.string(),
  recorded_at: z.string(),
});
const queryProfileRowSchema = z.object({
  joinResultRows: z.string(),
});

const testUserId = "00000000-0000-0000-0000-000000000001";
const overlapUserId = "00000000-0000-0000-0000-000000000002";
const crossMidnightActivityId = "00000000-0000-0000-0000-000000000201";
const overlappingActivityId = "00000000-0000-0000-0000-000000000202";
const activityCount = 100;
const expectedMatchCount = activityCount + 2;

describe("activity_sensor_sample read model", () => {
  let client: ClickHouseClient | undefined;
  const targetSchema = `analytics_activity_sensor_sample_test_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    client = createClient({
      url: requireClickHouseUrl(),
      request_timeout: 120_000,
    });
    await waitForClickHouse(client);
    await seedFixture(client, targetSchema);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${targetSchema} SYNC` });
      await client.close();
    }
  });

  it("joins samples to activity-day windows without cross-day amplification", async () => {
    const activeClient = requireClient(client);
    const queryId = `activity-sensor-sample-${randomUUID()}`;
    const result = await activeClient.query({
      query: renderActivitySensorSampleSql(targetSchema),
      query_id: queryId,
      format: "JSONEachRow",
    });
    const rows = z.array(activitySensorSampleRowSchema).parse(await result.json());

    expect(rows).toHaveLength(expectedMatchCount);
    expect(new Set(rows.map((row) => row.activity_id)).size).toBe(expectedMatchCount);
    expect(
      rows
        .filter((row) => row.recorded_at.startsWith("2026-05-02 00:15:00"))
        .map((row) => row.activity_id)
        .sort(),
    ).toEqual([crossMidnightActivityId, overlappingActivityId]);

    await activeClient.command({ query: "SYSTEM FLUSH LOGS" });
    const profileResult = await activeClient.query({
      query: `SELECT
          toString(ProfileEvents['JoinResultRowCount']) AS joinResultRows
        FROM system.query_log
        WHERE query_id = {queryId:String}
          AND type = 'QueryFinish'
        ORDER BY event_time_microseconds DESC
        LIMIT 1`,
      query_params: { queryId },
      format: "JSONEachRow",
    });
    const profileRows = z.tuple([queryProfileRowSchema]).parse(await profileResult.json());

    expect(profileRows).toHaveLength(1);
    expect(Number(profileRows[0].joinResultRows)).toBe(expectedMatchCount);
  }, 120_000);
});

function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) {
    throw new Error("CLICKHOUSE_URL is required for activity sensor sample integration tests");
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

function renderActivitySensorSampleSql(targetSchema: string): string {
  return readFileSync(
    join(import.meta.dirname, "../../analytics/models/read_models/activity_sensor_sample.sql"),
    "utf8",
  )
    .replace(/\{% set [^\n]+\n/g, "")
    .replace(/{{ config\([\s\S]*?\) }}\s*/, "")
    .replaceAll("{{ ref('deduped_activities') }}", `${targetSchema}.deduped_activities`)
    .replaceAll("{{ ref('deduped_sensor') }}", `${targetSchema}.deduped_sensor`)
    .concat("\nSETTINGS max_threads = 1");
}

async function seedFixture(client: ClickHouseClient, targetSchema: string): Promise<void> {
  await client.command({ query: `DROP DATABASE IF EXISTS ${targetSchema} SYNC` });
  await client.command({ query: `CREATE DATABASE ${targetSchema}` });
  await client.command({
    query: `CREATE TABLE ${targetSchema}.deduped_activities (
      activity_id UUID,
      user_id UUID,
      started_at DateTime64(6, 'UTC'),
      ended_at Nullable(DateTime64(6, 'UTC')),
      source_synced_at DateTime64(9, 'UTC'),
      is_deleted UInt8
    )
    ENGINE = ReplacingMergeTree()
    ORDER BY (user_id, activity_id)`,
  });
  await client.command({
    query: `CREATE TABLE ${targetSchema}.deduped_sensor (
      user_id UUID,
      recorded_at DateTime64(9, 'UTC'),
      recorded_date Date,
      channel String,
      scalar Nullable(Float64),
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    )
    ENGINE = MergeTree
    ORDER BY (user_id, recorded_date, channel, recorded_at)`,
  });

  const activityRows = Array.from({ length: activityCount }, (_, index) => {
    const startedAt = new Date(Date.UTC(2026, 0, index + 1, 12));
    const endedAt = new Date(startedAt.getTime() + 60 * 60 * 1000);
    return {
      activity_id: activityId(index),
      user_id: testUserId,
      started_at: clickHouseDateTime(startedAt),
      ended_at: clickHouseDateTime(endedAt),
      source_synced_at: clickHouseDateTime(endedAt),
      is_deleted: 0,
    };
  });
  activityRows.push(
    {
      activity_id: crossMidnightActivityId,
      user_id: overlapUserId,
      started_at: "2026-05-01 23:30:00.000",
      ended_at: "2026-05-02 00:30:00.000",
      source_synced_at: "2026-05-02 00:31:00.000",
      is_deleted: 0,
    },
    {
      activity_id: overlappingActivityId,
      user_id: overlapUserId,
      started_at: "2026-05-02 00:00:00.000",
      ended_at: "2026-05-02 01:00:00.000",
      source_synced_at: "2026-05-02 01:01:00.000",
      is_deleted: 0,
    },
  );
  const sensorRows = Array.from({ length: activityCount }, (_, index) => {
    const recordedAt = new Date(Date.UTC(2026, 0, index + 1, 12, 30));
    return {
      user_id: testUserId,
      recorded_at: clickHouseDateTime(recordedAt),
      recorded_date: recordedAt.toISOString().slice(0, 10),
      channel: "heart_rate",
      scalar: 100 + index,
      is_deleted: 0,
      refreshed_at: clickHouseDateTime(recordedAt),
    };
  });
  sensorRows.push({
    user_id: overlapUserId,
    recorded_at: "2026-05-02 00:15:00.000",
    recorded_date: "2026-05-02",
    channel: "heart_rate",
    scalar: 150,
    is_deleted: 0,
    refreshed_at: "2026-05-02 00:16:00.000",
  });

  await client.insert({
    table: `${targetSchema}.deduped_activities`,
    values: activityRows,
    format: "JSONEachRow",
  });
  await client.insert({
    table: `${targetSchema}.deduped_sensor`,
    values: sensorRows,
    format: "JSONEachRow",
  });
}

function activityId(index: number): string {
  return `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`;
}

function clickHouseDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}
