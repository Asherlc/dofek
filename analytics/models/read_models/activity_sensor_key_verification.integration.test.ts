import { randomUUID } from "node:crypto";
import { createClient, TupleParam } from "@clickhouse/client";
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
  runActivityPerformanceModel,
} from "./activity-performance-test-helpers.ts";

const rowSchema = z
  .object({
    user_id: z.uuid(),
    activity_id: z.uuid(),
    model: z.enum(["activity_pace_curve", "activity_heart_rate_distribution"]),
    current_present: z.number().int(),
    prior_present: z.number().int(),
    source_activity_version: z.string().nullable(),
    source_sensor_version: z.string().nullable(),
    canonical_type: z.string().nullable(),
    started_at: z.string().nullable(),
    ended_at: z.string().nullable(),
    source_is_deleted: z.number().int().nullable(),
    expected_is_deleted: z.number().int().nullable(),
    prior_activity_version: z.string().nullable(),
    prior_sensor_version: z.string().nullable(),
    prior_refresh_version: z.string().nullable(),
    prior_canonical_type: z.string().nullable(),
    prior_started_at: z.string().nullable(),
    prior_ended_at: z.string().nullable(),
    prior_is_deleted: z.number().int().nullable(),
    marker_count: z.string(),
    marker_durations: z.array(z.number().int()),
    marker_coherent: z.number().int(),
    marker_complete: z.number().int(),
    invalid_durations: z.array(z.number().int()),
    is_dirty: z.number().int(),
  })
  .strict();

// Independent expected inventory, including insufficient-duration empty markers.
const durations = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200];
const expectedColumnTypes = {
  user_id: "UUID",
  activity_id: "UUID",
  model: "String",
  current_present: "UInt8",
  prior_present: "UInt8",
  source_activity_version: "Nullable(String)",
  source_sensor_version: "Nullable(String)",
  canonical_type: "Nullable(String)",
  started_at: "Nullable(String)",
  ended_at: "Nullable(String)",
  source_is_deleted: "Nullable(UInt8)",
  expected_is_deleted: "Nullable(UInt8)",
  prior_activity_version: "Nullable(String)",
  prior_sensor_version: "Nullable(String)",
  prior_refresh_version: "Nullable(String)",
  prior_canonical_type: "Nullable(String)",
  prior_started_at: "Nullable(String)",
  prior_ended_at: "Nullable(String)",
  prior_is_deleted: "Nullable(UInt8)",
  marker_count: "String",
  marker_durations: "Array(UInt32)",
  marker_coherent: "UInt8",
  marker_complete: "UInt8",
  invalid_durations: "Array(UInt32)",
  is_dirty: "UInt8",
};

describe("bounded activity source and marker verification", () => {
  const database = `key_verification_${randomUUID().replaceAll("-", "")}`;
  const url = process.env.CLICKHOUSE_URL;
  if (!url) throw new Error("CLICKHOUSE_URL is required");
  const client = createClient({ url });
  const model = "activity_sensor_key_verification";
  const invocation = `${database}.${model}(target_user_ids={users:Array(UUID)}, target_activity_keys={keys:Array(Tuple(UUID, UUID))})`;
  const keys = [[activityPerformanceUserId, activityPerformanceId(1)]];

  beforeAll(async () => {
    process.stdout.write(
      `${JSON.stringify({ task6BKeyFixture: { database, phase: "setup", context: activitySensorCoverageQuerySettings } })}\n`,
    );
    await createActivityPerformanceFixture(client, database);
    for (const name of ["activity_pace_curve", "activity_heart_rate_distribution"])
      await client.command({
        query: buildTestAnalyticsTableStatement(`analytics.${name}`).replaceAll(
          "analytics.",
          `${database}.`,
        ),
      });
    await runActivityPerformanceModel(database, model, readModelSql(`${model}.sql`));
  });
  beforeEach(async () => {
    for (const table of [
      "deduped_activities",
      "deduped_sensor",
      "activity_pace_curve",
      "activity_heart_rate_distribution",
    ])
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
    await insertPerformanceActivities(client, database, [1], {
      version: 41,
      startedAt: "2026-09-01 12:00:00.123456",
      endedAt: "2026-09-01 13:00:00.654321",
    });
  });
  afterAll(async () => {
    let dropped = false;
    let absenceVerified = false;
    try {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      dropped = true;
      const result = await client.query({
        query: "SELECT name FROM system.databases WHERE name={database:String}",
        query_params: { database },
        format: "JSONEachRow",
      });
      const remaining = await result.json();
      expect(remaining).toEqual([]);
      absenceVerified = true;
    } finally {
      process.stdout.write(
        `${JSON.stringify({ task6BKeyFixture: { database, phase: "cleanup", dropped, absenceVerified } })}\n`,
      );
      await client.close();
    }
  });

  async function evidence(requestedKeys = keys) {
    const queryId = randomUUID();
    const started = performance.now();
    let completed = false;
    process.stdout.write(
      `${JSON.stringify({ task6BKeyVerificationRequest: { database, queryId, requestedKeys, context: activitySensorCoverageQuerySettings, phase: "started" } })}\n`,
    );
    try {
      const result = await client.query({
        query: `SELECT * FROM ${invocation} ORDER BY user_id, activity_id, model`,
        query_id: queryId,
        query_params: {
          users: [...new Set(requestedKeys.map(([userId]) => userId))],
          keys: requestedKeys.map((key) => new TupleParam(key)),
        },
        clickhouse_settings: activitySensorCoverageQuerySettings,
        format: "JSONEachRow",
      });
      const rows = z.array(rowSchema).parse(await result.json());
      expect(rows.map((row) => `${row.user_id}:${row.activity_id}:${row.model}`).sort()).toEqual(
        requestedKeys
          .flatMap(([userId, activityId]) =>
            ["activity_heart_rate_distribution", "activity_pace_curve"].map(
              (modelName) => `${userId}:${activityId}:${modelName}`,
            ),
          )
          .sort(),
      );
      process.stdout.write(
        `${JSON.stringify({ task6BKeyVerification: { queryId, elapsedMs: performance.now() - started, requestedKeys, rows } })}\n`,
      );
      completed = true;
      return rows;
    } finally {
      process.stdout.write(
        `${JSON.stringify({ task6BKeyVerificationRequest: { database, queryId, phase: "completed", completed, elapsedMs: performance.now() - started } })}\n`,
      );
    }
  }

  async function markers(inventory = durations, sensorVersion = "0", deleted = 0) {
    for (const modelName of ["activity_pace_curve", "activity_heart_rate_distribution"]) {
      const payload =
        modelName === "activity_pace_curve" ? `duration_seconds, best_speed,` : `samples,`;
      const values =
        modelName === "activity_pace_curve"
          ? `arrayJoin([${inventory.join(",")}]), CAST(NULL, 'Nullable(Float64)'),`
          : `CAST([], 'Array(Tuple(heart_rate Float64, sample_count UInt64))'),`;
      await client.command({
        query: `INSERT INTO ${database}.${modelName}
          (user_id, activity_id, ${payload} started_at, ended_at, canonical_type,
          source_activity_version, source_sensor_version, refresh_version, is_deleted, refreshed_at)
          SELECT user_id, activity_id, ${values} started_at,
            coalesce(ended_at, started_at + INTERVAL 12 HOUR), canonical_type,
            refresh_version, toUInt64('${sensorVersion}'), toUInt64(100), ${deleted}, now64(9)
          FROM ${database}.deduped_activities FINAL`,
      });
    }
  }

  async function sensor(
    channel: string,
    recordedAt: string,
    version: string,
    userId = activityPerformanceUserId,
    deleted = 0,
  ) {
    await client.insert({
      table: `${database}.deduped_sensor`,
      format: "JSONEachRow",
      values: [
        {
          user_id: userId,
          channel,
          recorded_at: recordedAt,
          scalar: 120,
          refresh_version: version,
          is_deleted: deleted,
        },
      ],
    });
  }

  it("initial canonical create exposes both exact source pairs with precise lifecycle and absent markers", async () => {
    const rows = await evidence();
    expect(rows.map((row) => row.model)).toEqual([
      "activity_heart_rate_distribution",
      "activity_pace_curve",
    ]);
    for (const row of rows)
      expect(row).toMatchObject({
        user_id: activityPerformanceUserId,
        activity_id: activityPerformanceId(1),
        current_present: 1,
        prior_present: 0,
        source_activity_version: "41",
        source_sensor_version: "0",
        canonical_type: "running",
        started_at: "2026-09-01 12:00:00.123456",
        ended_at: "2026-09-01 13:00:00.654321",
        source_is_deleted: 0,
        expected_is_deleted: 0,
        prior_activity_version: null,
        prior_sensor_version: null,
        prior_refresh_version: null,
        prior_started_at: null,
        prior_ended_at: null,
        marker_count: "0",
        marker_durations: [],
        marker_coherent: 0,
        marker_complete: 0,
        invalid_durations: [],
        is_dirty: 1,
      });
  });

  it("canonical replacement retains typed subquery schema and exact empty binding", async () => {
    await runActivityPerformanceModel(database, model, readModelSql(`${model}.sql`));
    const queryId = randomUUID();
    const started = performance.now();
    let completed = false;
    process.stdout.write(
      `${JSON.stringify({ task6BKeySchema: { database, queryId, phase: "started", context: activitySensorCoverageQuerySettings } })}\n`,
    );
    try {
      const result = await client.query({
        query: `DESCRIBE TABLE (SELECT * FROM ${invocation})`,
        query_id: queryId,
        query_params: {
          users: [activityPerformanceUserId],
          keys: keys.map((key) => new TupleParam(key)),
        },
        clickhouse_settings: activitySensorCoverageQuerySettings,
        format: "JSONEachRow",
      });
      const columns = await result.json<{ name: string; type: string }>();
      expect(
        Object.fromEntries(columns.map(({ name, type }) => [name, type.replaceAll(/\s/g, "")])),
      ).toEqual(expectedColumnTypes);
      completed = true;
    } finally {
      process.stdout.write(
        `${JSON.stringify({ task6BKeySchema: { database, queryId, phase: "completed", completed, elapsedMs: performance.now() - started } })}\n`,
      );
    }
    expect(await evidence([])).toEqual([]);
  });

  it("distinguishes requested absent identity from genuine zero clocks", async () => {
    await insertPerformanceActivities(client, database, [0], { version: 0 });
    const zero = await evidence([[activityPerformanceUserId, activityPerformanceId(0)]]);
    expect(zero).toHaveLength(2);
    for (const row of zero)
      expect(row).toMatchObject({
        current_present: 1,
        source_activity_version: "0",
        source_sensor_version: "0",
      });
    const absent = await evidence([[activityPerformanceUserId, activityPerformanceId(99)]]);
    expect(absent).toHaveLength(2);
    for (const row of absent)
      expect(row).toMatchObject({
        current_present: 0,
        prior_present: 0,
        source_activity_version: null,
        source_sensor_version: null,
        canonical_type: null,
        started_at: null,
        ended_at: null,
        expected_is_deleted: null,
        marker_count: "0",
      });
  });

  it("accepts coherent processed-empty markers from the actual canonical writers", async () => {
    for (const modelName of ["activity_pace_curve", "activity_heart_rate_distribution"]) {
      const sql = await compileActivityPerformanceModel(
        database,
        modelName,
        readModelSql(`${modelName}.sql`),
      );
      await client.command({
        query: `INSERT INTO ${database}.${modelName} ${sql}`,
        clickhouse_settings: activitySensorCoverageQuerySettings,
      });
    }
    for (const row of await evidence()) {
      expect(row).toMatchObject({
        current_present: 1,
        prior_present: 1,
        source_activity_version: "41",
        source_sensor_version: "0",
        prior_activity_version: "41",
        prior_sensor_version: "0",
        prior_canonical_type: "running",
        prior_started_at: "2026-09-01 12:00:00.123456",
        prior_ended_at: "2026-09-01 13:00:00.654321",
        prior_is_deleted: 0,
        marker_coherent: 1,
        marker_complete: 1,
        invalid_durations: [],
        is_dirty: 0,
      });
      expect(row.marker_count).toBe(row.model === "activity_pace_curve" ? "12" : "1");
      expect(row.marker_durations).toEqual(row.model === "activity_pace_curve" ? durations : []);
      expect(BigInt(row.prior_refresh_version ?? "0")).toBeGreaterThan(0n);
    }
  });

  it("keeps genuine zero UUIDs and clocks present with the precise twelve-hour fallback", async () => {
    const zeroUuid = "00000000-0000-0000-0000-000000000000";
    await client.command({
      query: `INSERT INTO ${database}.deduped_activities
      SELECT * REPLACE(toUUID('${zeroUuid}') AS user_id, toUUID('${zeroUuid}') AS activity_id,
        toUInt64(0) AS refresh_version, CAST(NULL AS Nullable(DateTime64(6, 'UTC'))) AS ended_at)
      FROM ${database}.deduped_activities FINAL`,
    });
    await markers();
    for (const row of await evidence([[zeroUuid, zeroUuid]]))
      expect(row).toMatchObject({
        current_present: 1,
        prior_present: 1,
        source_activity_version: "0",
        source_sensor_version: "0",
        prior_activity_version: "0",
        prior_sensor_version: "0",
        started_at: "2026-09-01 12:00:00.123456",
        ended_at: "2026-09-02 00:00:00.123456",
        prior_ended_at: "2026-09-02 00:00:00.123456",
        marker_complete: 1,
        is_dirty: 0,
      });
  });

  it("reports missing canonical pace duration without corrupting HR completeness", async () => {
    await markers(durations.slice(0, -1));
    const rows = await evidence();
    expect(rows[0]).toMatchObject({ marker_count: "1", marker_complete: 1, is_dirty: 0 });
    expect(rows[1]).toMatchObject({
      marker_count: "11",
      marker_durations: durations.slice(0, -1),
      marker_coherent: 1,
      marker_complete: 0,
      invalid_durations: [],
      is_dirty: 1,
    });
  });

  it("rejects mixed marker clocks even when all twelve durations exist", async () => {
    await markers();
    await client.command({
      query: `INSERT INTO ${database}.activity_pace_curve
      SELECT * REPLACE(toUInt64(101) AS refresh_version, toUInt64(40) AS source_activity_version)
      FROM ${database}.activity_pace_curve AS fixture_source FINAL WHERE fixture_source.duration_seconds=5400`,
    });
    const rows = await evidence();
    expect(rows[1]).toMatchObject({
      marker_count: "12",
      marker_durations: durations,
      marker_coherent: 0,
      marker_complete: 0,
      invalid_durations: [],
      is_dirty: 1,
    });
    expect(rows[0]?.marker_complete).toBe(1);
  });

  it("exposes wrong twelve-member pace inventory as an explicit extra-duration blocker", async () => {
    await markers([...durations.slice(0, -1), 7300]);
    const rows = await evidence();
    expect(rows[1]).toMatchObject({
      marker_count: "12",
      marker_durations: [...durations.slice(0, -1), 7300],
      marker_coherent: 1,
      marker_complete: 0,
      invalid_durations: [7300],
      is_dirty: 1,
    });
    expect(rows[0]).toMatchObject({ marker_complete: 1, invalid_durations: [] });
  });

  it("preserves live ineligible source versus model-specific output tombstones", async () => {
    await insertPerformanceActivities(client, database, [1], {
      version: 42,
      canonicalType: "strength",
    });
    await markers(durations, "0", 1);
    for (const row of await evidence())
      expect(row).toMatchObject({
        current_present: 1,
        prior_present: 1,
        canonical_type: "strength",
        source_activity_version: "42",
        source_is_deleted: 0,
        expected_is_deleted: 1,
        prior_is_deleted: 1,
        marker_coherent: 1,
        marker_complete: 1,
      });
  });

  it("distinguishes prior-only disappearance, deletion and resurrected source lifecycle", async () => {
    await markers();
    await client.command({ query: `TRUNCATE TABLE ${database}.deduped_activities` });
    for (const row of await evidence())
      expect(row).toMatchObject({
        current_present: 0,
        prior_present: 1,
        source_activity_version: "41",
        source_is_deleted: 1,
        expected_is_deleted: 1,
        prior_is_deleted: 0,
        marker_complete: 0,
        is_dirty: 1,
      });
    await insertPerformanceActivities(client, database, [1], { version: 42, deleted: 1 });
    for (const row of await evidence())
      expect(row).toMatchObject({
        current_present: 1,
        prior_present: 1,
        source_activity_version: "42",
        source_is_deleted: 1,
        expected_is_deleted: 1,
        marker_complete: 0,
        is_dirty: 1,
      });
    await insertPerformanceActivities(client, database, [1], { version: 43 });
    for (const row of await evidence())
      expect(row).toMatchObject({
        current_present: 1,
        source_activity_version: "43",
        source_is_deleted: 0,
        expected_is_deleted: 0,
        marker_complete: 0,
        is_dirty: 1,
      });
  });

  it("retains precise moved lifecycle and both old and new days with monotonic model clocks", async () => {
    await markers(durations, "100");
    await insertPerformanceActivities(client, database, [1], {
      version: 42,
      startedAt: "2026-09-03 23:59:59.123456",
      endedAt: "2026-09-04 00:00:00.654321",
    });
    await sensor("speed", "2026-09-01 12:00:00", "110", activityPerformanceUserId, 1);
    await sensor("speed", "2026-09-04 00:00:00", "90");
    await sensor("heart_rate", "2026-09-01 12:00:00", "120");
    await sensor("heart_rate", "2026-09-03 23:59:59", "80");
    await sensor("speed", "2026-09-05 00:00:00", "999");
    await sensor("power", "2026-09-03 23:59:59", "999");
    await sensor("speed", "2026-09-03 23:59:59", "999", activityPerformanceId(2));
    const rows = await evidence();
    for (const row of rows)
      expect(row).toMatchObject({
        source_activity_version: "42",
        started_at: "2026-09-03 23:59:59.123456",
        ended_at: "2026-09-04 00:00:00.654321",
        prior_started_at: "2026-09-01 12:00:00.123456",
        prior_ended_at: "2026-09-01 13:00:00.654321",
        prior_sensor_version: "100",
        marker_complete: 0,
        is_dirty: 1,
      });
    expect(rows.map((row) => row.source_sensor_version)).toEqual(["120", "110"]);
  });

  it("observes later source changes losslessly and isolates identical activity IDs across users", async () => {
    await markers();
    expect((await evidence()).map((row) => row.marker_complete)).toEqual([1, 1]);
    await insertPerformanceActivities(client, database, [1], { version: 42 });
    await sensor("speed", "2026-09-01 12:30:00", "9007199254740993");
    const otherUser = activityPerformanceId(2);
    await client.command({
      query: `INSERT INTO ${database}.deduped_activities
      SELECT * REPLACE(toUUID('${otherUser}') AS user_id, toUInt64(99) AS refresh_version)
      FROM ${database}.deduped_activities AS fixture_source FINAL
      WHERE fixture_source.user_id=toUUID('${activityPerformanceUserId}')`,
    });
    const seedQueryId = randomUUID();
    const seedResult = await client.query({
      query: `SELECT toString(user_id) AS user_id, toString(activity_id) AS activity_id,
        toString(refresh_version) AS refresh_version
        FROM ${database}.deduped_activities AS fixture_source FINAL
        WHERE fixture_source.user_id={otherUser:UUID} AND fixture_source.activity_id={activityId:UUID}`,
      query_id: seedQueryId,
      query_params: { otherUser, activityId: activityPerformanceId(1) },
      format: "JSONEachRow",
    });
    const seeded = z
      .array(
        z
          .object({ user_id: z.uuid(), activity_id: z.uuid(), refresh_version: z.string() })
          .strict(),
      )
      .parse(await seedResult.json());
    expect(seeded).toEqual([
      { user_id: otherUser, activity_id: activityPerformanceId(1), refresh_version: "99" },
    ]);
    process.stdout.write(
      `${JSON.stringify({ task6BKeyFixtureSeed: { database, queryId: seedQueryId, rows: seeded } })}\n`,
    );
    await sensor("speed", "2026-09-01 12:30:00", "9007199254740994", otherUser);
    const rows = await evidence();
    expect(rows.map((row) => row.source_sensor_version)).toEqual(["0", "9007199254740993"]);
    for (const row of rows)
      expect(row).toMatchObject({ source_activity_version: "42", marker_complete: 0, is_dirty: 1 });
    const other = await evidence([[otherUser, activityPerformanceId(1)]]);
    expect(other.map((row) => row.source_sensor_version)).toEqual(["0", "9007199254740994"]);
    for (const row of other)
      expect(row).toMatchObject({ source_activity_version: "99", prior_present: 0 });
  });
});
