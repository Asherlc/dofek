import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ClickHouseActivitySensorStore } from "../../../packages/server/src/repositories/clickhouse-activity-sensor-store.ts";
import type { ClickHouseQueryClient } from "../../../packages/server/src/repositories/clickhouse-activity-sensor-types.ts";
import { buildTestAnalyticsTableStatement } from "../../../packages/server/src/routers/clickhouse-integration-test-models.ts";
import {
  activityPerformanceId,
  activityPerformanceUserId,
  compileActivityPerformanceModel,
  createActivityPerformanceFixture,
  insertPerformanceActivities,
  insertPerformanceActivity,
} from "./activity-performance-test-helpers.ts";

const durations = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200];
const rowSchema = z.object({
  activity_id: z.string(),
  duration_seconds: z.number(),
  best_speed: z.number().nullable(),
  started_at: z.string(),
  ended_at: z.string(),
  canonical_type: z.string(),
  source_activity_version: z.string(),
  source_sensor_version: z.string(),
  refresh_version: z.string(),
  refreshed_at: z.string(),
  is_deleted: z.number(),
});

describe("activity_pace_curve exact duration model", () => {
  const database = `pace_curve_${randomUUID().replaceAll("-", "")}`;
  const url = process.env.CLICKHOUSE_URL;
  if (!url) throw new Error("CLICKHOUSE_URL is required");
  const client = createClient({ url });
  let sql: string;
  let initialSql: string;
  beforeAll(async () => {
    await createActivityPerformanceFixture(client, database);
    const source = await readFile(new URL("./activity_pace_curve.sql", import.meta.url), "utf8");
    initialSql = await compileActivityPerformanceModel(database, "activity_pace_curve", source);
    await client.command({
      query: buildTestAnalyticsTableStatement(`${database}.activity_pace_curve`),
    });
    sql = await compileActivityPerformanceModel(database, "activity_pace_curve", source);
  });
  beforeEach(async () => {
    for (const table of ["deduped_activities", "deduped_sensor", "activity_pace_curve"])
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
  });
  async function build(initial = false) {
    await client.command({
      query: `INSERT INTO ${database}.activity_pace_curve ${initial ? initialSql : sql}
        SETTINGS max_threads = 1, join_use_nulls = 1, enable_materialized_cte = 1`,
    });
  }
  async function rows(index?: number) {
    const result = await client.query({
      query: `SELECT * REPLACE(
        toString(source_activity_version) AS source_activity_version,
        toString(source_sensor_version) AS source_sensor_version,
        toString(refresh_version) AS refresh_version)
        FROM ${database}.activity_pace_curve FINAL
        ${index === undefined ? "" : `WHERE activity_id = '${activityPerformanceId(index)}'`}
        ORDER BY activity_id, duration_seconds`,
      format: "JSONEachRow",
    });
    return z.array(rowSchema).parse(await result.json());
  }
  async function samples(
    start: string,
    speeds: readonly (number | null)[],
    offsets = speeds.map((_, index) => index),
    deleted = 0,
  ) {
    // One batch/native process. The canonical writer supplies the real nanosecond clock.
    await client.command({
      query: `INSERT INTO ${database}.deduped_sensor
        (user_id, channel, recorded_at, scalar, source_activity_id, refresh_version, is_deleted)
        SELECT '${activityPerformanceUserId}', 'speed',
          addSeconds(toDateTime64('${start}', 6, 'UTC'), sample.1), sample.2,
          toUUID('${activityPerformanceId(9999)}'),
          toUInt64(toUnixTimestamp64Nano(now64(9))), ${deleted}
        FROM (SELECT arrayJoin([${speeds.map((speed, index) => `(${offsets[index]}, ${speed ?? "CAST(NULL, 'Nullable(Float64)')"})`).join(",")}]) AS sample)`,
    });
  }
  function best(result: z.infer<typeof rowSchema>[], duration = 5) {
    return result.find((row) => row.duration_seconds === duration)?.best_speed;
  }
  async function unchanged() {
    const previous = await rows();
    const count = await client.query({
      query: `SELECT count() AS n FROM ${database}.activity_pace_curve`,
      format: "JSONEachRow",
    });
    await build();
    expect(await rows()).toEqual(previous);
    const after = await client.query({
      query: `SELECT count() AS n FROM ${database}.activity_pace_curve`,
      format: "JSONEachRow",
    });
    expect(await after.json()).toEqual(await count.json());
  }

  it("persists all durations including insufficient windows and keeps unrelated-linked temporal samples", async () => {
    await insertPerformanceActivity(client, database, 1);
    await samples("2026-09-01 12:00:00", Array(10).fill(4));
    await build();
    const result = await rows(1);
    expect(result.map((row) => row.duration_seconds)).toEqual(durations);
    expect(best(result)).toBe(4);
    expect(best(result, 15)).toBeNull();
    expect(result.every((row) => row.is_deleted === 0)).toBe(true);
    expect(new Set(result.map((row) => row.refresh_version)).size).toBe(1);
    expect(result.every((row) => row.source_sensor_version !== "0")).toBe(true);
    await unchanged();
  });

  it("persists the 12-hour effective end and advances a processed-empty sensor deletion", async () => {
    await insertPerformanceActivity(client, database, 1, { endedAt: null });
    // Two sparse positive samples imply interval43200, therefore the 5s
    // minimum one-sample window can use the inclusive12-hour endpoint.
    await samples("2026-09-01 12:00:00", [4, 5, 100], [0, 43200, 43201]);
    await build();
    expect(best(await rows(1))).toBe(5);
    expect((await rows(1))[0]?.ended_at).toBe("2026-09-02 00:00:00.000000");
    const previous = (await rows(1))[0];
    await samples("2026-09-01 12:00:00", [4, 5, 100], [0, 43200, 43201], 1);
    await build();
    expect((await rows(1)).every((row) => row.best_speed === null && row.is_deleted === 0)).toBe(
      true,
    );
    expect(BigInt((await rows(1))[0]?.source_sensor_version ?? 0)).toBeGreaterThan(
      BigInt(previous?.source_sensor_version ?? 0),
    );
    await unchanged();
    await samples("2026-09-01 12:00:00", [4, 5], [0, 43200]);
    await build();
    expect(best(await rows(1))).toBe(5);
  });

  it("preserves irregular interval rounding, invalid filtering and raw cumulative means", async () => {
    await insertPerformanceActivity(client, database, 1);
    // Positive times 0,1,3,7,10: interval round(10/4)=2 (banker's rounding).
    // 5s window round(5/2)=2; best adjacent positive pair (7+8)/2=7.5.
    await samples("2026-09-01 12:00:00", [1, 3, 0, 7, -2, null, 8, 2], [0, 1, 2, 3, 4, 5, 7, 10]);
    await build();
    expect(best(await rows(1))).toBe(7.5);
    expect(best(await rows(1), 15)).toBeNull();
    await samples(
      "2026-09-01 12:00:00",
      [1, 3, 0, 7, -2, null, 8, 2],
      [0, 1, 2, 3, 4, 5, 7, 10],
      1,
    );
    await samples("2026-09-01 12:00:00", [1, 2, 4, 8, 16, 32]);
    await build();
    // One-second samples: final five sum to62, divide by5; no pace rounding.
    expect(best(await rows(1))).toBeCloseTo(12.4, 12);
  });

  it("uses inclusive cross-midnight bounds, ties and rounded duration windows", async () => {
    await insertPerformanceActivity(client, database, 1, {
      startedAt: "2026-09-01 23:59:55",
      endedAt: "2026-09-02 00:00:10",
    });
    // interval3; round(5/3)=2, round(15/3)=5. Repeated winning pair ties at6.
    await samples("2026-09-01 23:59:55", [4, 8, 4, 8, 4, 8], [0, 3, 6, 9, 12, 15]);
    await build();
    const result = await rows(1);
    expect(best(result)).toBe(6);
    expect(best(result, 15)).toBe(6.4);
    expect(best(result, 30)).toBeNull();
    expect(result[0]?.started_at).toBe("2026-09-01 23:59:55.000000");
    expect(result[0]?.ended_at).toBe("2026-09-02 00:00:10.000000");
    const store = new ClickHouseActivitySensorStore({
      command: (options) => client.command(options),
      async query<TRow extends object>(options: Parameters<ClickHouseQueryClient["query"]>[0]) {
        const result = await client.query({
          ...options,
          query: options.query.replaceAll("analytics.", `${database}.`),
          clickhouse_settings: { final: 1 },
        });
        return { json: () => result.json<TRow>() };
      },
    });
    // Compare the actual unchanged request implementation on the same canonical
    // source state. The hand-calculated assertions above are independent of it.
    expect(await store.getPaceCurveRows(null, activityPerformanceUserId, "UTC")).toEqual([
      { duration_seconds: 5, best_pace: 166.7, activity_date: "2026-09-01" },
      { duration_seconds: 15, best_pace: 156.2, activity_date: "2026-09-01" },
    ]);
  });

  it("replaces the faster winner on deletion and restores it on resurrection", async () => {
    await insertPerformanceActivity(client, database, 1);
    await samples("2026-09-01 12:00:00", Array(10).fill(4));
    await insertPerformanceActivity(client, database, 2, {
      startedAt: "2026-09-02 12:00:00",
      endedAt: "2026-09-02 13:00:00",
    });
    await samples("2026-09-02 12:00:00", Array(10).fill(5));
    await build();
    const winner = async () =>
      Math.max(
        ...(await rows())
          .filter((row) => row.duration_seconds === 5 && row.is_deleted === 0)
          .map((row) => row.best_speed ?? 0),
      );
    expect(await winner()).toBe(5);
    await insertPerformanceActivity(client, database, 2, { deleted: 1 });
    await build();
    expect(await winner()).toBe(4);
    expect((await rows(2)).every((row) => row.best_speed === null && row.is_deleted === 1)).toBe(
      true,
    );
    await unchanged();
    await insertPerformanceActivity(client, database, 2, {
      startedAt: "2026-09-02 12:00:00",
      endedAt: "2026-09-02 13:00:00",
    });
    await build();
    expect(await winner()).toBe(5);
  });

  it("records empty, one-sample, ineligible, type-change and reversed-window lifecycle", async () => {
    await insertPerformanceActivity(client, database, 1);
    await insertPerformanceActivity(client, database, 2, { canonicalType: "climbing" });
    await insertPerformanceActivity(client, database, 3, {
      startedAt: "2026-09-01 13:00:00",
      endedAt: "2026-09-01 12:00:00",
    });
    await build();
    expect((await rows(1)).every((row) => row.best_speed === null && row.is_deleted === 0)).toBe(
      true,
    );
    expect((await rows(2)).every((row) => row.best_speed === null && row.is_deleted === 1)).toBe(
      true,
    );
    expect(
      (await rows(3)).every(
        (row) => row.best_speed === null && row.ended_at === "2026-09-01 12:00:00.000000",
      ),
    ).toBe(true);
    await unchanged();
    await samples("2026-09-01 12:00:00", [4]);
    await build();
    expect(best(await rows(1))).toBeNull();
    await samples("2026-09-01 12:00:00", Array(10).fill(4));
    await insertPerformanceActivity(client, database, 2, { canonicalType: "walking" });
    await build();
    expect(best(await rows(2))).toBe(4);
    await insertPerformanceActivity(client, database, 2, { canonicalType: "yoga" });
    await build();
    expect(
      (await rows(2)).every((row) => row.is_deleted === 1 && row.canonical_type === "yoga"),
    ).toBe(true);
    await unchanged();
  });

  it("reconciles corrections, shifted windows, merge/split and missing source keys", async () => {
    await insertPerformanceActivities(client, database, [1, 2]);
    await samples("2026-09-01 12:00:00", Array(10).fill(4));
    await build();
    const before = (await rows(1))[0];
    await samples("2026-09-01 12:00:00", Array(10).fill(6));
    await build();
    const corrected = (await rows(1))[0];
    expect(best(await rows(1))).toBe(6);
    expect(BigInt(corrected?.source_sensor_version ?? 0)).toBeGreaterThan(
      BigInt(before?.source_sensor_version ?? 0),
    );
    expect(BigInt(corrected?.refresh_version ?? 0)).toBeGreaterThan(
      BigInt(before?.refresh_version ?? 0),
    );
    await insertPerformanceActivity(client, database, 1, { deleted: 1 });
    await insertPerformanceActivity(client, database, 2, {
      members: [activityPerformanceId(1001), activityPerformanceId(1002)],
      startedAt: "2026-09-01 12:00:02",
      endedAt: "2026-09-01 12:00:05",
    });
    await build();
    expect(best(await rows(2))).toBeNull();
    expect((await rows(1)).every((row) => row.is_deleted === 1)).toBe(true);
    await insertPerformanceActivities(client, database, [1, 2]);
    await build();
    expect(best(await rows(1))).toBe(6);
    expect(best(await rows(2))).toBe(6);
    await client.command({ query: `TRUNCATE TABLE ${database}.deduped_activities` });
    await build();
    expect((await rows()).every((row) => row.is_deleted === 1 && row.best_speed === null)).toBe(
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
    expect(await rows()).toHaveLength(32 * 12);
  });

  it("drains 65 activities through bounded incremental builds with all 12 duration markers", async () => {
    await insertPerformanceActivities(
      client,
      database,
      Array.from({ length: 65 }, (_, index) => index + 1),
    );
    await build();
    expect(await rows()).toHaveLength(32 * 12);
    await build();
    expect(await rows()).toHaveLength(64 * 12);
    await build();
    expect(await rows()).toHaveLength(65 * 12);
    const completed = await rows();
    expect(completed).toHaveLength(65 * 12);
    expect(new Set(completed.map((row) => row.activity_id)).size).toBe(65);
    expect(new Set(completed.map((row) => `${row.activity_id}:${row.duration_seconds}`)).size).toBe(
      65 * 12,
    );
  });
});
