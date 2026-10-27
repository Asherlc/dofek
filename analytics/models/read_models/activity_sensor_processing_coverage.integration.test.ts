import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildTestAnalyticsTableStatement } from "../../../packages/server/src/routers/clickhouse-integration-test-models.ts";
import { readModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";
import {
  activityPerformanceId,
  activityPerformanceUserId,
  activitySensorCoverageQuerySettings,
  compileActivityPerformanceModel,
  createActivityPerformanceFixture,
  insertPerformanceActivities,
  insertPerformanceSensor,
  runActivityPerformanceModel,
} from "./activity-performance-test-helpers.ts";

const coverageSchema = z.array(
  z.object({
    user_id: z.string(),
    model: z.string(),
    pending_keys: z.array(
      z.object({
        activity_id: z.string(),
        source_activity_version: z.string(),
        source_sensor_version: z.string(),
        processing_age: z.string(),
      }),
    ),
    invalid_duration_keys: z.array(z.string()),
  }),
);

describe("compact activity coverage preparation", () => {
  const database = `compact_coverage_${randomUUID().replaceAll("-", "")}`;
  const url = process.env.CLICKHOUSE_URL;
  if (!url) throw new Error("CLICKHOUSE_URL is required");
  const client = createClient({ url });
  let paceSql: string;
  let hrSql: string;
  const coverageQuery = `SELECT user_id, model, pending_keys, invalid_duration_keys
    FROM ${database}.activity_sensor_processing_coverage(target_user_ids={userIds:Array(UUID)})
    ORDER BY model`;

  async function coverage(userId = activityPerformanceUserId) {
    const result = await client.query({
      query: coverageQuery,
      clickhouse_settings: activitySensorCoverageQuerySettings,
      query_params: { userIds: [userId] },
      format: "JSONEachRow",
    });
    return coverageSchema.parse(await result.json());
  }

  async function build(
    model: "activity_pace_curve" | "activity_heart_rate_distribution",
    sql: string,
  ) {
    const queryId = randomUUID();
    const started = performance.now();
    await client.command({
      query: `INSERT INTO ${database}.${model} ${sql}
        SETTINGS max_threads = 1, join_use_nulls = 1, enable_materialized_cte = 1`,
      query_id: queryId,
    });
    process.stdout.write(
      `${JSON.stringify({
        task6ABuild: {
          model,
          queryId,
          elapsedMs: performance.now() - started,
        },
      })}\n`,
    );
  }

  async function distinctPaceKeys() {
    const result = await client.query({
      query: `SELECT toString(activity_id) AS activity_id
        FROM ${database}.activity_pace_curve FINAL GROUP BY activity_id ORDER BY activity_id`,
      format: "JSONEachRow",
    });
    return result.json<{ activity_id: string }>();
  }

  beforeAll(async () => {
    await createActivityPerformanceFixture(client, database);
    for (const model of ["activity_pace_curve", "activity_heart_rate_distribution"]) {
      await client.command({
        query: buildTestAnalyticsTableStatement(`analytics.${model}`).replaceAll(
          "analytics.",
          `${database}.`,
        ),
      });
    }
    paceSql = await compileActivityPerformanceModel(
      database,
      "activity_pace_curve",
      readModelSql("activity_pace_curve.sql"),
    );
    hrSql = await compileActivityPerformanceModel(
      database,
      "activity_heart_rate_distribution",
      readModelSql("activity_heart_rate_distribution.sql"),
    );
    await runActivityPerformanceModel(
      database,
      "activity_sensor_processing_coverage",
      readModelSql("activity_sensor_processing_coverage.sql"),
    );
  });
  beforeEach(async () => {
    for (const table of [
      "deduped_activities",
      "deduped_sensor",
      "activity_pace_curve",
      "activity_heart_rate_distribution",
    ])
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
  });

  it("exposes every pending key for the requested user rather than the writer's oldest 32", async () => {
    await insertPerformanceActivities(
      client,
      database,
      Array.from({ length: 65 }, (_, index) => index + 1),
    );
    const result = await client.query({
      query: coverageQuery,
      clickhouse_settings: activitySensorCoverageQuerySettings,
      query_params: { userIds: [activityPerformanceUserId] },
      format: "JSONEachRow",
    });
    const rows = await result.json<{ model: string; pending_keys: unknown[] }>();
    expect(rows.map(({ model, pending_keys }) => [model, pending_keys.length])).toEqual([
      ["activity_heart_rate_distribution", 65],
      ["activity_pace_curve", 65],
    ]);
  });

  it("restricts exact captured user/key/source pairs before the 32-key admission limit", async () => {
    await insertPerformanceActivities(
      client,
      database,
      Array.from({ length: 65 }, (_, index) => index + 1),
      { version: 41 },
    );
    const capturedSql = await compileActivityPerformanceModel(
      database,
      "activity_pace_curve",
      readModelSql("activity_pace_curve.sql"),
      {
        activity_sensor_captured_keys: [
          {
            user_id: activityPerformanceUserId,
            activity_id: activityPerformanceId(65),
            source_activity_version: "41",
            source_sensor_version: "0",
          },
        ],
      },
    );
    await build("activity_pace_curve", capturedSql);
    expect(await distinctPaceKeys()).toEqual([{ activity_id: activityPerformanceId(65) }]);
  });

  it("repairs an incomplete current pace marker set instead of accepting one latest duration", async () => {
    await insertPerformanceActivities(client, database, [1]);
    await build("activity_pace_curve", paceSql);
    await build("activity_heart_rate_distribution", hrSql);
    await client.command({
      query: `ALTER TABLE ${database}.activity_pace_curve DELETE
        WHERE duration_seconds = 7200 SETTINGS mutations_sync = 2`,
    });
    expect((await coverage()).map(({ pending_keys }) => pending_keys.length)).toEqual([0, 1]);
    await build("activity_pace_curve", paceSql);
    const result = await client.query({
      query: `SELECT count() AS rows FROM ${database}.activity_pace_curve FINAL`,
      format: "JSONEachRow",
    });
    const rows = await result.json<{ rows: number | string }>();
    expect(Number(rows[0]?.rows)).toBe(12);
    expect((await coverage()).map(({ pending_keys }) => pending_keys.length)).toEqual([0, 0]);
  });

  it("repairs disappeared processed-empty activities and resurrects their current keys", async () => {
    await insertPerformanceActivities(client, database, [1], { version: 41 });
    await build("activity_pace_curve", paceSql);
    await build("activity_heart_rate_distribution", hrSql);
    expect((await coverage()).map(({ pending_keys }) => pending_keys)).toEqual([[], []]);
    await client.command({ query: `TRUNCATE TABLE ${database}.deduped_activities` });
    expect((await coverage()).map(({ pending_keys }) => pending_keys.length)).toEqual([1, 1]);
    await build("activity_pace_curve", paceSql);
    await build("activity_heart_rate_distribution", hrSql);
    expect((await coverage()).map(({ pending_keys }) => pending_keys)).toEqual([[], []]);
    await insertPerformanceActivities(client, database, [1], { version: 42 });
    await build("activity_pace_curve", paceSql);
    await build("activity_heart_rate_distribution", hrSql);
    expect((await coverage()).map(({ pending_keys }) => pending_keys)).toEqual([[], []]);
    const live = await client.query({
      query: `SELECT toString(count()) AS rows FROM ${database}.activity_pace_curve FINAL WHERE is_deleted = 0`,
      format: "JSONEachRow",
    });
    expect(await live.json()).toEqual([{ rows: "12" }]);
  });

  it("retains deleted prior-only users with zero pending keys and excludes unknown users", async () => {
    await insertPerformanceActivities(client, database, [1], { version: 41 });
    await build("activity_pace_curve", paceSql);
    await build("activity_heart_rate_distribution", hrSql);
    await insertPerformanceActivities(client, database, [1], { version: 43, deleted: 1 });
    expect((await coverage()).map(({ pending_keys }) => pending_keys.length)).toEqual([1, 1]);
    await build("activity_pace_curve", paceSql);
    await build("activity_heart_rate_distribution", hrSql);
    expect((await coverage()).map(({ pending_keys }) => pending_keys)).toEqual([[], []]);
    await client.command({ query: `TRUNCATE TABLE ${database}.deduped_activities` });
    expect((await coverage()).map(({ pending_keys }) => pending_keys)).toEqual([[], []]);
    expect(await coverage(activityPerformanceId(999))).toEqual([]);
  });

  it("reports exact deterministic source pairs and retains both writers' normal 32-key limit", async () => {
    await insertPerformanceActivities(
      client,
      database,
      Array.from({ length: 65 }, (_, index) => index + 1),
      { version: 41 },
    );
    const initial = await coverage();
    expect(
      initial.every(({ pending_keys }) =>
        pending_keys.every(
          (key, index) =>
            key.activity_id === activityPerformanceId(index + 1) &&
            key.source_activity_version === "41" &&
            key.source_sensor_version === "0" &&
            key.processing_age === "41",
        ),
      ),
    ).toBe(true);
    await build("activity_pace_curve", paceSql);
    await build("activity_heart_rate_distribution", hrSql);
    const written = await client.query({
      query: `SELECT * FROM (
        SELECT 'activity_pace_curve' AS model, toString(uniqExact(activity_id)) AS keys FROM ${database}.activity_pace_curve FINAL
        UNION ALL SELECT 'activity_heart_rate_distribution' AS model, toString(uniqExact(activity_id)) AS keys FROM ${database}.activity_heart_rate_distribution FINAL
        ) ORDER BY model`,
      format: "JSONEachRow",
    });
    const writtenKeys = await written.json();
    const firstPending = await coverage();
    process.stdout.write(
      `${JSON.stringify({ task6APendingCount: { writtenKeys, firstPending } })}\n`,
    );
    expect(writtenKeys).toEqual([
      { model: "activity_heart_rate_distribution", keys: "32" },
      { model: "activity_pace_curve", keys: "32" },
    ]);
    expect(firstPending.map(({ pending_keys }) => pending_keys.length)).toEqual([33, 33]);
    await build("activity_pace_curve", paceSql);
    await build("activity_heart_rate_distribution", hrSql);
    expect((await coverage()).map(({ pending_keys }) => pending_keys.length)).toEqual([1, 1]);
    await build("activity_pace_curve", paceSql);
    await build("activity_heart_rate_distribution", hrSql);
    expect((await coverage()).map(({ pending_keys }) => pending_keys)).toEqual([[], []]);
  });

  it("rejects changed source pairs while keeping captured admission isolated by user", async () => {
    const otherUser = activityPerformanceId(2);
    await insertPerformanceActivities(client, database, [65], { version: 41 });
    await client.command({
      query: `INSERT INTO ${database}.deduped_activities
        SELECT * REPLACE(toUUID('${otherUser}') AS user_id)
        FROM ${database}.deduped_activities FINAL`,
    });
    const capturedSql = await compileActivityPerformanceModel(
      database,
      "activity_pace_curve",
      readModelSql("activity_pace_curve.sql"),
      {
        activity_sensor_captured_keys: [
          {
            user_id: activityPerformanceUserId,
            activity_id: activityPerformanceId(65),
            source_activity_version: "41",
            source_sensor_version: "0",
          },
        ],
      },
    );
    await build("activity_pace_curve", capturedSql);
    const written = await client.query({
      query: `SELECT DISTINCT toString(user_id) AS user_id FROM ${database}.activity_pace_curve FINAL`,
      format: "JSONEachRow",
    });
    expect(await written.json()).toEqual([{ user_id: activityPerformanceUserId }]);
    expect((await coverage(otherUser)).map(({ pending_keys }) => pending_keys.length)).toEqual([
      1, 1,
    ]);
    await client.command({ query: `TRUNCATE TABLE ${database}.activity_pace_curve` });
    await insertPerformanceActivities(client, database, [65], { version: 42 });
    await build("activity_pace_curve", capturedSql);
    expect(await distinctPaceKeys()).toEqual([]);
    await client.command({ query: `TRUNCATE TABLE ${database}.deduped_activities` });
    await insertPerformanceActivities(client, database, [65], { version: 41 });
    await insertPerformanceSensor(client, database, "2026-09-01 12:30:00", { channel: "speed" });
    await build("activity_pace_curve", capturedSql);
    expect(await distinctPaceKeys()).toEqual([]);
    const sensorResult = await client.query({
      query: `SELECT toString(max(refresh_version)) AS version FROM ${database}.deduped_sensor
        WHERE user_id = {userId:UUID} AND channel = 'speed'`,
      query_params: { userId: activityPerformanceUserId },
      format: "JSONEachRow",
    });
    const sensorVersions = await sensorResult.json<{ version: string }>();
    const pendingSensorVersion = (await coverage())[1]?.pending_keys[0]?.source_sensor_version;
    expect(pendingSensorVersion).toBe(sensorVersions[0]?.version);
    expect(BigInt(pendingSensorVersion ?? "0")).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it("repairs mixed lifecycle clocks across all twelve canonical markers", async () => {
    await insertPerformanceActivities(client, database, [1]);
    await build("activity_pace_curve", paceSql);
    await build("activity_heart_rate_distribution", hrSql);
    await client.command({
      query: `INSERT INTO ${database}.activity_pace_curve
        SELECT * REPLACE(refresh_version + 1 AS refresh_version)
        FROM ${database}.activity_pace_curve FINAL WHERE duration_seconds = 5400`,
    });
    expect((await coverage()).map(({ pending_keys }) => pending_keys.length)).toEqual([0, 1]);
    await build("activity_pace_curve", paceSql);
    expect((await coverage()).map(({ pending_keys }) => pending_keys.length)).toEqual([0, 0]);
  });

  it("reports a wrong twelve-member inventory as an integrity blocker rather than complete coverage", async () => {
    await insertPerformanceActivities(client, database, [1]);
    await build("activity_pace_curve", paceSql);
    await build("activity_heart_rate_distribution", hrSql);
    await client.command({
      query: `ALTER TABLE ${database}.activity_pace_curve DELETE WHERE duration_seconds = 7200 SETTINGS mutations_sync = 2`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_pace_curve
        SELECT * REPLACE(toUInt32(7300) AS duration_seconds)
        FROM ${database}.activity_pace_curve AS fixture_source FINAL
        WHERE fixture_source.duration_seconds = 5400`,
    });
    const inventory = await client.query({
      query: `SELECT arraySort(groupUniqArray(duration_seconds)) AS durations FROM ${database}.activity_pace_curve FINAL`,
      format: "JSONEachRow",
    });
    const actualInventory = await inventory.json();
    const rows = await coverage();
    process.stdout.write(
      `${JSON.stringify({ task6AInvalidInventory: { actualInventory, rows } })}\n`,
    );
    expect(actualInventory).toEqual([
      { durations: [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7300] },
    ]);
    expect(rows[1]?.invalid_duration_keys).toEqual([activityPerformanceId(1)]);
    expect(rows[1]?.pending_keys.map(({ activity_id }) => activity_id)).toEqual([
      activityPerformanceId(1),
    ]);
    expect(rows[0]?.invalid_duration_keys).toEqual([]);
  });

  it("admits a maximum captured batch without serializing the full backlog into argv", async () => {
    await insertPerformanceActivities(
      client,
      database,
      Array.from({ length: 65 }, (_, index) => index + 1),
      { version: 41 },
    );
    const captured = Array.from({ length: 32 }, (_, index) => ({
      user_id: activityPerformanceUserId,
      activity_id: activityPerformanceId(index + 34),
      source_activity_version: "41",
      source_sensor_version: "0",
    }));
    const variables = { activity_sensor_captured_keys: captured };
    const sql = await compileActivityPerformanceModel(
      database,
      "activity_pace_curve",
      readModelSql("activity_pace_curve.sql"),
      variables,
    );
    await build("activity_pace_curve", sql);
    expect(await distinctPaceKeys()).toEqual(captured.map(({ activity_id }) => ({ activity_id })));
    const maximalPayload = JSON.stringify({
      activity_sensor_captured_keys: captured.map((key) => ({
        ...key,
        source_activity_version: "18446744073709551615",
        source_sensor_version: "18446744073709551615",
      })),
    });
    process.stdout.write(
      `${JSON.stringify({ task6ACapturedPayload: { keys: captured.length, actualBytes: Buffer.byteLength(JSON.stringify(variables)), maximalUInt64Bytes: Buffer.byteLength(maximalPayload) } })}\n`,
    );
  });

  it("hard-fails malformed or oversized captured input before rendering SQL", async () => {
    const key = {
      user_id: activityPerformanceUserId,
      activity_id: activityPerformanceId(1),
      source_activity_version: "41",
      source_sensor_version: "0",
    };
    const cases = [
      { keys: [], message: "1 to 32 exact source pairs" },
      { keys: Array.from({ length: 33 }, () => key), message: "1 to 32 exact source pairs" },
      { keys: [{ ...key, user_id: "invalid'UUID" }], message: "requires UUID user_id" },
      {
        keys: [{ ...key, source_sensor_version: 41 }],
        message: "requires lossless UInt64 source_sensor_version",
      },
      {
        keys: [{ ...key, source_activity_version: "18446744073709551616" }],
        message: "requires lossless UInt64 source_activity_version",
      },
    ];
    for (const { keys, message } of cases) {
      await expect(
        compileActivityPerformanceModel(
          database,
          "activity_pace_curve",
          readModelSql("activity_pace_curve.sql"),
          { activity_sensor_captured_keys: keys },
        ),
      ).rejects.toThrow(message);
    }
  });
  it("scopes required-user view reads before materialized CTE work", async () => {
    await insertPerformanceActivities(client, database, [1], { version: 41 });
    await build("activity_pace_curve", paceSql);
    await build("activity_heart_rate_distribution", hrSql);
    await insertPerformanceSensor(client, database, "2026-09-01 12:30:00", { channel: "speed" });
    await insertPerformanceSensor(client, database, "2026-09-01 12:30:00");
    async function measuredRead(userIds = [activityPerformanceUserId]) {
      const queryId = randomUUID();
      const result = await client.query({
        query: coverageQuery,
        clickhouse_settings: activitySensorCoverageQuerySettings,
        query_id: queryId,
        query_params: { userIds },
        format: "JSON",
      });
      const response = await result.json<{
        data: unknown;
        statistics: { elapsed: number; rows_read: number; bytes_read: number };
      }>();
      const rows = coverageSchema.parse(response.data);
      expect(rows).toHaveLength(userIds.length * 2);
      expect(new Set(rows.map(({ user_id }) => user_id))).toEqual(new Set(userIds));
      return { queryId, statistics: response.statistics, targetUsers: userIds.length };
    }
    const baseline = await measuredRead();
    await client.command({
      query: `INSERT INTO ${database}.deduped_activities
        (user_id, activity_id, started_at, ended_at, member_activity_ids, refresh_version, is_deleted)
        SELECT toUUID(concat('ffffffff-ffff-4fff-8fff-', leftPad(toString(number), 12, '0'))),
          toUUID('${activityPerformanceId(1)}'), toDateTime64('2026-09-01 12:00:00', 6, 'UTC'),
          toDateTime64('2026-09-01 13:00:00', 6, 'UTC'), [], 41, 0 FROM numbers(20000)`,
    });
    for (const table of [
      "deduped_sensor",
      "activity_pace_curve",
      "activity_heart_rate_distribution",
    ]) {
      await client.command({
        query: `INSERT INTO ${database}.${table}
          SELECT * REPLACE(toUUID(concat('ffffffff-ffff-4fff-8fff-', leftPad(toString(arrayJoin(range(20000))), 12, '0'))) AS user_id)
          FROM ${database}.${table} AS fixture_source FINAL
          WHERE fixture_source.user_id = toUUID('${activityPerformanceUserId}')`,
      });
    }
    await client.command({
      query: `INSERT INTO ${database}.activity_pace_curve
        SELECT * REPLACE(toUUID(concat('ffffffff-ffff-4fff-8fff-', leftPad(toString(arrayJoin(range(20000))), 12, '0'))) AS user_id,
          toUInt32(7300) AS duration_seconds)
        FROM ${database}.activity_pace_curve AS fixture_source FINAL
        WHERE fixture_source.user_id = toUUID('${activityPerformanceUserId}') AND fixture_source.duration_seconds = 5400`,
    });
    const fixture = await client.query({
      query: `SELECT * FROM (
        SELECT 'activities' AS source, toString(count()) AS rows FROM ${database}.deduped_activities FINAL
        UNION ALL SELECT 'sensor', toString(count()) FROM ${database}.deduped_sensor FINAL
        UNION ALL SELECT 'pace', toString(count()) FROM ${database}.activity_pace_curve FINAL
        UNION ALL SELECT 'heart_rate', toString(count()) FROM ${database}.activity_heart_rate_distribution FINAL
        ) ORDER BY source`,
      format: "JSONEachRow",
    });
    const fixtureRows = await fixture.json();
    expect(fixtureRows).toEqual([
      { source: "activities", rows: "20001" },
      { source: "heart_rate", rows: "20001" },
      { source: "pace", rows: "260012" },
      { source: "sensor", rows: "40002" },
    ]);
    const expanded = await measuredRead();
    const largeTargets = [
      activityPerformanceUserId,
      ...Array.from(
        { length: 128 },
        (_, index) => `ffffffff-ffff-4fff-8fff-${String(index).padStart(12, "0")}`,
      ),
    ];
    const targeted = await measuredRead(largeTargets);
    const plan = await client.query({
      query: `EXPLAIN PLAN indexes = 1 ${coverageQuery}`,
      clickhouse_settings: activitySensorCoverageQuerySettings,
      query_params: { userIds: [activityPerformanceUserId] },
      format: "TabSeparated",
    });
    const explanation = await plan.text();
    await client.command({ query: "SYSTEM FLUSH LOGS" });
    const log = await client.query({
      query: `SELECT query_id, read_rows, memory_usage, query_duration_ms, Settings FROM system.query_log
        WHERE query_id IN ({queryIds:Array(String)}) AND type = 'QueryFinish' AND is_initial_query = 1 ORDER BY query_id`,
      query_params: { queryIds: [baseline.queryId, expanded.queryId, targeted.queryId] },
      format: "JSONEachRow",
    });
    const queryMetrics = await log.json();
    process.stdout.write(
      `${JSON.stringify({
        task6AResource: {
          unrelatedActivities: 20000,
          unrelatedSensors: 40000,
          unrelatedPaceMarkers: 260000,
          unrelatedHeartRateMarkers: 20000,
          fixtureRows,
          baseline,
          expanded,
          targeted,
          queryMetrics,
          explanation,
        },
      })}\n`,
    );
    expect(queryMetrics).toHaveLength(3);
    expect(expanded.statistics.rows_read).toBeLessThan(20000);
  });
});
