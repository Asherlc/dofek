import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

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
const expectedJoinResultCount = expectedMatchCount;

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
    expect(Number(profileRows[0].joinResultRows)).toBe(expectedJoinResultCount);
  }, 120_000);

  it("reconciles stale rows from key-scoped current versions without full-table FINAL", async () => {
    const activeClient = requireClient(client);
    const movedActivityId = "00000000-0000-0000-0000-000000000301";
    const staleActivityId = "00000000-0000-0000-0000-000000000302";
    const unrelatedActivityId = "00000000-0000-0000-0000-000000000303";
    const unrelatedUserId = "00000000-0000-0000-0000-000000000099";
    const batchRecordedAt = "2026-06-01 12:30:00.000000000";
    const unrelatedCount = 5_000;

    await activeClient.command({
      query: `TRUNCATE TABLE ${targetSchema}.deduped_activities`,
    });
    await activeClient.command({
      query: `TRUNCATE TABLE ${targetSchema}.deduped_sensor`,
    });
    await activeClient.command({
      query: `DROP TABLE IF EXISTS ${targetSchema}.activity_sensor_sample SYNC`,
    });
    await activeClient.command({
      query: `CREATE TABLE ${targetSchema}.activity_sensor_sample (
        activity_id UUID,
        user_id UUID,
        recorded_at DateTime64(9, 'UTC'),
        recorded_date Date,
        channel String,
        scalar Nullable(Float64),
        provider_id String,
        member_activity_id Nullable(UUID),
        device_id Nullable(String),
        source_external_id Nullable(String),
        source_type Nullable(String),
        source_metric_stream_id UUID,
        measurement_kind String,
        refresh_version UInt64,
        is_deleted UInt8,
        refreshed_at DateTime64(9, 'UTC')
      )
      ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, recorded_date, channel, recorded_at)`,
    });

    await activeClient.insert({
      table: `${targetSchema}.deduped_activities`,
      values: [
        {
          activity_id: movedActivityId,
          user_id: testUserId,
          started_at: "2026-06-01 12:00:00.000",
          ended_at: "2026-06-01 13:00:00.000",
          source_synced_at: "2026-06-01 13:01:00.000",
          member_activity_ids: [movedActivityId],
          is_deleted: 0,
          refreshed_at: "2026-06-01 13:01:00.000",
        },
        {
          activity_id: staleActivityId,
          user_id: testUserId,
          started_at: "2026-06-01 12:00:00.000",
          ended_at: "2026-06-01 13:00:00.000",
          source_synced_at: "2026-06-01 13:01:00.000",
          member_activity_ids: [staleActivityId],
          is_deleted: 0,
          refreshed_at: "2026-06-01 13:01:00.000",
        },
      ],
      format: "JSONEachRow",
    });

    await activeClient.insert({
      table: `${targetSchema}.deduped_sensor`,
      values: [
        {
          user_id: testUserId,
          recorded_at: batchRecordedAt,
          recorded_date: "2026-06-01",
          channel: "heart_rate",
          scalar: 142,
          provider_id: "wahoo",
          member_activity_id: movedActivityId,
          device_id: "kickr-bike",
          source_external_id: "moved-sample",
          source_type: "activity",
          source_metric_stream_id: "10000000-0000-0000-0000-000000000301",
          measurement_kind: "direct",
          source_activity_id: movedActivityId,
          refresh_version: 2,
          is_deleted: 0,
          refreshed_at: "2026-06-02 00:00:00.000",
        },
      ],
      format: "JSONEachRow",
    });

    const targetRows = [
      {
        activity_id: staleActivityId,
        user_id: testUserId,
        recorded_at: batchRecordedAt,
        recorded_date: "2026-06-01",
        channel: "heart_rate",
        scalar: 140,
        provider_id: "wahoo",
        member_activity_id: staleActivityId,
        device_id: "kickr-bike",
        source_external_id: "stale-sample",
        source_type: "activity",
        source_metric_stream_id: "10000000-0000-0000-0000-000000000302",
        measurement_kind: "direct",
        refresh_version: 1,
        is_deleted: 0,
        refreshed_at: "2026-06-01 13:00:00.000",
      },
      {
        activity_id: staleActivityId,
        user_id: testUserId,
        recorded_at: batchRecordedAt,
        recorded_date: "2026-06-01",
        channel: "heart_rate",
        scalar: 141,
        provider_id: "wahoo",
        member_activity_id: staleActivityId,
        device_id: "kickr-bike",
        source_external_id: "stale-sample-old-version",
        source_type: "activity",
        source_metric_stream_id: "10000000-0000-0000-0000-000000000302",
        measurement_kind: "direct",
        refresh_version: 0,
        is_deleted: 0,
        refreshed_at: "2026-06-01 12:59:00.000",
      },
      ...Array.from({ length: unrelatedCount }, (_, index) => ({
        activity_id: unrelatedActivityId,
        user_id: unrelatedUserId,
        recorded_at: `2026-05-01 12:${String(index % 60).padStart(2, "0")}:00.000000000`,
        recorded_date: "2026-05-01",
        channel: "heart_rate",
        scalar: index,
        provider_id: "wahoo",
        member_activity_id: unrelatedActivityId,
        device_id: "kickr-bike",
        source_external_id: `unrelated-${index}`,
        source_type: "activity",
        source_metric_stream_id: `20000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
        measurement_kind: "direct",
        refresh_version: index + 1,
        is_deleted: 0,
        refreshed_at: "2026-05-01 13:00:00.000",
      })),
    ];
    await activeClient.insert({
      table: `${targetSchema}.activity_sensor_sample`,
      values: targetRows,
      format: "JSONEachRow",
    });

    const queryId = `activity-sensor-sample-stale-${randomUUID()}`;
    const result = await activeClient.query({
      query: renderIncrementalActivitySensorSampleSql(targetSchema),
      query_id: queryId,
      format: "JSONEachRow",
    });
    const rows = z
      .array(
        z.object({
          activity_id: z.string(),
          is_deleted: z.coerce.number().int(),
          scalar: z.coerce.number().nullable(),
        }),
      )
      .parse(await result.json());

    const staleRows = rows.filter((row) => row.is_deleted === 1);
    const activeRows = rows.filter((row) => row.is_deleted === 0);

    expect(activeRows).toEqual([
      expect.objectContaining({
        activity_id: movedActivityId,
        is_deleted: 0,
        scalar: 142,
      }),
    ]);
    expect(staleRows).toEqual([
      expect.objectContaining({
        activity_id: staleActivityId,
        is_deleted: 1,
        scalar: 140,
      }),
    ]);

    await activeClient.command({ query: "SYSTEM FLUSH LOGS" });
    const profileResult = await activeClient.query({
      query: `SELECT
          toUInt64(read_rows) AS readRows
        FROM system.query_log
        WHERE query_id = {queryId:String}
          AND type = 'QueryFinish'
        ORDER BY event_time_microseconds DESC
        LIMIT 1`,
      query_params: { queryId },
      format: "JSONEachRow",
    });
    const profileRows = z
      .tuple([z.object({ readRows: z.coerce.number().int().nonnegative() })])
      .parse(await profileResult.json());

    expect(profileRows[0].readRows).toBeLessThan(unrelatedCount);
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
  return renderDbtModelSql(readModelSql("activity_sensor_sample.sql"), {
    isIncremental: false,
    activityRefreshScoped: false,
  })
    .replaceAll("{{ ref('deduped_activities') }}", `${targetSchema}.deduped_activities`)
    .replaceAll("{{ ref('deduped_sensor') }}", `${targetSchema}.deduped_sensor`)
    .concat("\nSETTINGS max_threads = 1");
}

function renderIncrementalActivitySensorSampleSql(targetSchema: string): string {
  return renderDbtModelSql(readModelSql("activity_sensor_sample.sql"), {
    isIncremental: true,
    activityRefreshScoped: false,
  })
    .replaceAll("{{ ref('deduped_activities') }}", `${targetSchema}.deduped_activities`)
    .replaceAll("{{ ref('deduped_sensor') }}", `${targetSchema}.deduped_sensor`)
    .replaceAll("{{ this }}", `${targetSchema}.activity_sensor_sample`)
    .concat("\nSETTINGS max_threads = 1, join_use_nulls = 1");
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
      member_activity_ids Array(UUID),
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
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
      provider_id String,
      member_activity_id Nullable(UUID),
      device_id Nullable(String),
      source_external_id Nullable(String),
      source_type Nullable(String),
      source_metric_stream_id UUID,
      measurement_kind String,
      source_activity_id Nullable(UUID),
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    )
    ENGINE = ReplacingMergeTree(refresh_version)
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
      member_activity_ids: [activityId(index)],
      is_deleted: 0,
      refreshed_at: clickHouseDateTime(endedAt),
    };
  });
  activityRows.push(
    {
      activity_id: crossMidnightActivityId,
      user_id: overlapUserId,
      started_at: "2026-05-01 23:30:00.000",
      ended_at: "2026-05-02 00:30:00.000",
      source_synced_at: "2026-05-02 00:31:00.000",
      member_activity_ids: [crossMidnightActivityId],
      is_deleted: 0,
      refreshed_at: "2026-05-02 00:31:00.000",
    },
    {
      activity_id: overlappingActivityId,
      user_id: overlapUserId,
      started_at: "2026-05-02 00:00:00.000",
      ended_at: "2026-05-02 01:00:00.000",
      source_synced_at: "2026-05-02 01:01:00.000",
      member_activity_ids: [overlappingActivityId],
      is_deleted: 0,
      refreshed_at: "2026-05-02 01:01:00.000",
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
      provider_id: "wahoo",
      member_activity_id: activityId(index),
      device_id: "kickr-bike",
      source_external_id: `sample-${index}`,
      source_type: "activity",
      source_metric_stream_id: `10000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
      measurement_kind: "direct",
      source_activity_id: null,
      refresh_version: index + 1,
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
    provider_id: "wahoo",
    member_activity_id: crossMidnightActivityId,
    device_id: "tickr",
    source_external_id: "sample-overlap",
    source_type: "activity",
    source_metric_stream_id: "10000000-0000-0000-0000-000000000201",
    measurement_kind: "direct",
    source_activity_id: null,
    refresh_version: activityCount + 1,
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
