import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildTestAnalyticsTableStatement } from "../../../packages/server/src/routers/clickhouse-integration-test-models.ts";
import {
  activityPerformanceId,
  activityPerformanceUserId,
  compileActivityPerformanceModel,
  createActivityPerformanceFixture,
  insertPerformanceActivities,
  insertPerformanceActivity,
  refreshPerformanceCanonicalSensors,
} from "./activity-performance-test-helpers.ts";

const countSchema = z.union([z.number(), z.string()]).transform(Number);
const sampleSchema = z.union([
  z.tuple([z.number(), countSchema]),
  z
    .object({ heart_rate: z.number(), sample_count: countSchema })
    .transform(({ heart_rate, sample_count }): [number, number] => [heart_rate, sample_count]),
]);
const rowSchema = z.object({
  user_id: z.string(),
  activity_id: z.string(),
  samples: z.array(sampleSchema),
  started_at: z.string(),
  ended_at: z.string(),
  canonical_type: z.string(),
  source_activity_version: z.string(),
  source_sensor_version: z.string(),
  refresh_version: z.string(),
  refreshed_at: z.string(),
  is_deleted: z.number(),
});

describe("activity_heart_rate_distribution exact value/count model", () => {
  const database = `heart_rate_distribution_${randomUUID().replaceAll("-", "")}`;
  const url = process.env.CLICKHOUSE_URL;
  if (!url) throw new Error("CLICKHOUSE_URL is required");
  const client = createClient({ url });
  let sql: string;
  let initialSql: string;
  beforeAll(async () => {
    await createActivityPerformanceFixture(client, database);
    const source = await readFile(
      new URL("./activity_heart_rate_distribution.sql", import.meta.url),
      "utf8",
    );
    initialSql = await compileActivityPerformanceModel(
      database,
      "activity_heart_rate_distribution",
      source,
    );
    await client.command({
      query: buildTestAnalyticsTableStatement(`${database}.activity_heart_rate_distribution`),
    });
    sql = await compileActivityPerformanceModel(
      database,
      "activity_heart_rate_distribution",
      source,
    );
  });
  beforeEach(async () => {
    for (const table of [
      "deduped_activities",
      "deduped_sensor",
      "sensor_scalar_sample",
      "activity_heart_rate_distribution",
    ])
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
  });
  async function build(initial = false) {
    await client.command({
      query: `INSERT INTO ${database}.activity_heart_rate_distribution ${initial ? initialSql : sql}
        SETTINGS max_threads = 1, join_use_nulls = 1, enable_materialized_cte = 1`,
    });
  }
  async function rows(index?: number, userId = activityPerformanceUserId) {
    const result = await client.query({
      query: `SELECT * REPLACE(
        toString(source_activity_version) AS source_activity_version,
        toString(source_sensor_version) AS source_sensor_version,
        toString(refresh_version) AS refresh_version)
        FROM ${database}.activity_heart_rate_distribution FINAL
        WHERE user_id = '${userId}'
        ${index === undefined ? "" : `AND activity_id = '${activityPerformanceId(index)}'`}
        ORDER BY activity_id`,
      format: "JSONEachRow",
    });
    return z.array(rowSchema).parse(await result.json());
  }
  async function samples(
    start: string,
    values: readonly (number | null)[],
    offsets = values.map((_, index) => index),
    options: { deleted?: number; userId?: string; channel?: string } = {},
  ) {
    // Batch fixtures in one native process and use the actual canonical writer clock.
    await client.command({
      query: `INSERT INTO ${database}.deduped_sensor
        (user_id, channel, recorded_at, scalar, source_activity_id, refresh_version, is_deleted)
        SELECT '${options.userId ?? activityPerformanceUserId}', '${options.channel ?? "heart_rate"}',
          addSeconds(toDateTime64('${start}', 6, 'UTC'), sample.1), sample.2,
          toUUID('${activityPerformanceId(9999)}'),
          toUInt64(toUnixTimestamp64Nano(now64(9))), ${options.deleted ?? 0}
        FROM (SELECT arrayJoin([${values.map((value, index) => `(${offsets[index]}, ${value ?? "CAST(NULL, 'Nullable(Float64)')"})`).join(",")}]) AS sample)`,
    });
  }
  async function distribution(index: number, userId = activityPerformanceUserId) {
    const result = await rows(index, userId);
    expect(result).toHaveLength(1);
    return result[0]?.samples;
  }
  async function unchanged() {
    const previous = await rows();
    const physicalRows = async () => {
      const result = await client.query({
        query: `SELECT count() AS n FROM ${database}.activity_heart_rate_distribution`,
        format: "JSONEachRow",
      });
      return result.json();
    };
    const before = await physicalRows();
    await build();
    expect(await rows()).toEqual(previous);
    expect(await physicalRows()).toEqual(before);
  }

  it("preserves fractional HR values and exact sample counts", async () => {
    await insertPerformanceActivity(client, database, 1);
    // The preferred provider and overlapping fallback both report each timestamp.
    // Their unrelated activity links stay eligible under the Training predicate.
    await client.insert({
      table: `${database}.sensor_scalar_sample`,
      format: "JSONEachRow",
      values: [129.5, 130, 130, 143.5, 144].flatMap((value, index) =>
        [0, 1].map((priority) => ({
          id: randomUUID(),
          user_id: activityPerformanceUserId,
          recorded_at: `2026-09-01 12:00:0${index}`,
          channel: "heart_rate",
          scalar: priority === 0 ? value : 200,
          provider_id: priority === 0 ? "preferred" : "fallback",
          provider_priority: priority,
          activity_id: activityPerformanceId(9999),
          member_activity_id: activityPerformanceId(9999),
          _peerdb_is_deleted: 0,
          _peerdb_synced_at: "2026-09-01 12:01:00.000000000",
        })),
      ),
    });
    await refreshPerformanceCanonicalSensors(client, database);
    await build();
    const samples = await distribution(1);
    expect(samples).toEqual([
      [129.5, 1],
      [130, 2],
      [143.5, 1],
      [144, 1],
    ]);
    await unchanged();
  });

  it("resolves canonical replacements before filtering null and deleted payloads", async () => {
    await insertPerformanceActivity(client, database, 1);
    await samples("2026-09-01 12:00:00", [120, 130, 140, 0, -1]);
    await build();
    expect(await distribution(1)).toEqual([
      [-1, 1],
      [0, 1],
      [120, 1],
      [130, 1],
      [140, 1],
    ]);
    const previous = (await rows(1))[0];
    await samples("2026-09-01 12:00:00", [null, 135, 140], [0, 1, 2]);
    await samples("2026-09-01 12:00:00", [140], [2], { deleted: 1 });
    await samples("2026-09-01 12:00:00", [999], [0], { channel: "speed" });
    await build();
    expect(await distribution(1)).toEqual([
      [-1, 1],
      [0, 1],
      [135, 1],
    ]);
    expect(BigInt((await rows(1))[0]?.source_sensor_version ?? 0)).toBeGreaterThan(
      BigInt(previous?.source_sensor_version ?? 0),
    );
    await unchanged();
  });

  it("advances completed empty markers when the last sample is removed and resurrected", async () => {
    await insertPerformanceActivity(client, database, 1);
    await samples("2026-09-01 12:00:00", [129.5]);
    await build();
    const before = (await rows(1))[0];
    await samples("2026-09-01 12:00:00", [129.5], [0], { deleted: 1 });
    await build();
    const empty = (await rows(1))[0];
    expect(empty).toMatchObject({
      samples: [],
      is_deleted: 0,
      source_activity_version: before?.source_activity_version,
    });
    expect(BigInt(empty?.source_sensor_version ?? 0)).toBeGreaterThan(
      BigInt(before?.source_sensor_version ?? 0),
    );
    await unchanged();
    await samples("2026-09-01 12:00:00", [143.5]);
    await build();
    expect(await distribution(1)).toEqual([[143.5, 1]]);
  });

  it("retains inclusive midnight and twelve-hour fallback endpoints", async () => {
    await insertPerformanceActivity(client, database, 1, {
      startedAt: "2026-09-01 23:59:59",
      endedAt: "2026-09-02 00:00:00",
    });
    await insertPerformanceActivity(client, database, 2, { endedAt: null });
    await samples("2026-09-01 12:00:00", [90, 100, 110, 120, 130], [-1, 0, 43199, 43200, 43201]);
    await build();
    expect(await distribution(1)).toEqual([
      [110, 1],
      [120, 1],
    ]);
    expect(await distribution(2)).toEqual([
      [100, 1],
      [110, 1],
      [120, 1],
    ]);
    expect((await rows(2))[0]?.ended_at).toBe("2026-09-02 00:00:00.000000");
    await unchanged();
    await samples("2026-09-01 23:59:59", [111]);
    await build();
    expect(await distribution(1)).toEqual([
      [111, 1],
      [120, 1],
    ]);
  });

  it("isolates a second user sharing the same activity key and temporal window", async () => {
    const secondUser = activityPerformanceId(2);
    await insertPerformanceActivity(client, database, 1);
    await client.command({
      query: `INSERT INTO ${database}.deduped_activities
      (user_id, activity_id, started_at, ended_at, member_activity_ids, is_deleted)
      SELECT '${secondUser}', '${activityPerformanceId(1)}', toDateTime64('2026-09-01 12:00:00', 6, 'UTC'),
        toDateTime64('2026-09-01 13:00:00', 6, 'UTC'), [], 0`,
    });
    await samples("2026-09-01 12:00:00", [130]);
    await samples("2026-09-01 12:00:00", [144], [0], { userId: secondUser });
    await build();
    expect(await distribution(1)).toEqual([[130, 1]]);
    expect(await distribution(1, secondUser)).toEqual([[144, 1]]);
    const before = (await rows(1))[0];
    await samples("2026-09-01 12:00:00", [145], [0], { userId: secondUser });
    await build();
    expect((await rows(1))[0]).toEqual(before);
    expect(await distribution(1, secondUser)).toEqual([[145, 1]]);
  });

  it("persists unavailable, ineligible, deletion and type-change lifecycle states", async () => {
    await insertPerformanceActivity(client, database, 1);
    await insertPerformanceActivity(client, database, 2, { canonicalType: "climbing" });
    await insertPerformanceActivity(client, database, 3, {
      startedAt: "2026-09-01 13:00:00",
      endedAt: "2026-09-01 12:00:00",
    });
    await build();
    expect((await rows(1))[0]).toMatchObject({
      samples: [],
      is_deleted: 0,
      source_sensor_version: "0",
    });
    expect(BigInt((await rows(1))[0]?.source_activity_version ?? 0)).toBeGreaterThan(0n);
    expect((await rows(2))[0]).toMatchObject({
      samples: [],
      is_deleted: 1,
      canonical_type: "climbing",
    });
    expect((await rows(3))[0]).toMatchObject({
      samples: [],
      is_deleted: 0,
      ended_at: "2026-09-01 12:00:00.000000",
    });
    await unchanged();
    await samples("2026-09-01 12:00:00", [130]);
    await insertPerformanceActivity(client, database, 2, { canonicalType: "walking" });
    await insertPerformanceActivity(client, database, 1, { deleted: 1 });
    await build();
    expect((await rows(1))[0]).toMatchObject({ samples: [], is_deleted: 1 });
    expect(await distribution(2)).toEqual([[130, 1]]);
    await insertPerformanceActivity(client, database, 1);
    await insertPerformanceActivity(client, database, 2, { canonicalType: "yoga" });
    await build();
    expect(await distribution(1)).toEqual([[130, 1]]);
    expect((await rows(2))[0]).toMatchObject({
      samples: [],
      is_deleted: 1,
      canonical_type: "yoga",
    });
    await unchanged();
  });

  it("reconciles overlapping and changed windows with late samples, merges, splits and source disappearance", async () => {
    await insertPerformanceActivities(client, database, [1, 2]);
    await samples("2026-09-01 12:00:00", [129.5, 130, 143.5, 144]);
    await build();
    expect(await distribution(1)).toEqual([
      [129.5, 1],
      [130, 1],
      [143.5, 1],
      [144, 1],
    ]);
    expect(await distribution(2)).toEqual(await distribution(1));
    await insertPerformanceActivity(client, database, 1, { deleted: 1 });
    await insertPerformanceActivity(client, database, 2, {
      members: [activityPerformanceId(1001), activityPerformanceId(1002)],
      startedAt: "2026-09-01 12:00:02",
      endedAt: "2026-09-01 12:00:03",
    });
    await build();
    expect((await rows(1))[0]).toMatchObject({ samples: [], is_deleted: 1 });
    expect(await distribution(2)).toEqual([
      [143.5, 1],
      [144, 1],
    ]);
    const merged = (await rows(2))[0];
    await samples("2026-09-01 12:00:02.500000", [150.5]);
    await build();
    expect(await distribution(2)).toEqual([
      [143.5, 1],
      [144, 1],
      [150.5, 1],
    ]);
    expect(BigInt((await rows(2))[0]?.source_sensor_version ?? 0)).toBeGreaterThan(
      BigInt(merged?.source_sensor_version ?? 0),
    );
    await insertPerformanceActivities(client, database, [1, 2]);
    await build();
    expect(await distribution(1)).toEqual([
      [129.5, 1],
      [130, 1],
      [143.5, 1],
      [144, 1],
      [150.5, 1],
    ]);
    expect(await distribution(2)).toEqual(await distribution(1));
    await client.command({ query: `TRUNCATE TABLE ${database}.deduped_activities` });
    await build();
    expect((await rows()).every((row) => row.is_deleted === 1 && row.samples.length === 0)).toBe(
      true,
    );
    await unchanged();
  });

  it("bounds the first build at 32 unique activity keys", async () => {
    await insertPerformanceActivities(
      client,
      database,
      Array.from({ length: 65 }, (_, index) => index + 1),
    );
    await build(true);
    expect(await rows()).toHaveLength(32);
  });

  it("drains 65 processed-empty activities through bounded builds with complete markers", async () => {
    await insertPerformanceActivities(
      client,
      database,
      Array.from({ length: 65 }, (_, index) => index + 1),
    );
    await build();
    expect(await rows()).toHaveLength(32);
    await build();
    expect(await rows()).toHaveLength(64);
    await build();
    const completed = await rows();
    expect(completed).toHaveLength(65);
    expect(new Set(completed.map((row) => `${row.user_id}:${row.activity_id}`)).size).toBe(65);
    expect(
      completed.every(
        (row) =>
          row.samples.length === 0 &&
          row.is_deleted === 0 &&
          row.source_sensor_version === "0" &&
          BigInt(row.source_activity_version) > 0n,
      ),
    ).toBe(true);
  });
});
