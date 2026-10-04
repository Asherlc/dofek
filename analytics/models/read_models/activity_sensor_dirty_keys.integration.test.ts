import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { clickHouseMigrations } from "../../../src/db/clickhouse-migrations/registry.ts";
import {
  activityPerformanceId,
  activityPerformanceUserId,
  compileActivityDirtyKeys,
  compileActivityPerformanceModel,
  createActivityPerformanceFixture,
  insertPerformanceActivities,
  insertPerformanceActivity,
  insertPerformanceSensor,
  persistActivityDirtyKeys,
  refreshPerformanceCanonicalSensors,
  runActivityPerformanceModel,
} from "./activity-performance-test-helpers.ts";

const dirtyKeySchema = z.object({
  user_id: z.string(),
  activity_id: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
  prior_started_at: z.string().nullable(),
  prior_ended_at: z.string().nullable(),
  canonical_type: z.string(),
  source_activity_version: z.coerce.number(),
  source_sensor_version: z.string(),
  source_is_deleted: z.coerce.number(),
});

describe("0099 activity sensor day versions", () => {
  const database = `activity_performance_${randomUUID().replaceAll("-", "")}`;
  const url = process.env.CLICKHOUSE_URL;
  if (!url) throw new Error("CLICKHOUSE_URL is required");
  const client = createClient({ url });
  let sql: string;
  const migration = clickHouseMigrations("postgres://test").find(
    ({ id }) => id === "0099_activity_sensor_day_versions",
  );
  async function applyMigration() {
    for (const query of migration?.statements ?? []) {
      await client.command({
        query: query.replaceAll("analytics.deduped_sensor", `${database}.deduped_sensor`),
      });
    }
  }
  async function keys(querySql = sql) {
    const result = await client.query({
      query: `SELECT * REPLACE(toString(source_sensor_version) AS source_sensor_version)
        FROM (${querySql}) SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
      format: "JSONEachRow",
    });
    return z.array(dirtyKeySchema).parse(await result.json());
  }
  beforeAll(async () => {
    await createActivityPerformanceFixture(client, database);
    sql = await compileActivityDirtyKeys(database);
  });
  beforeEach(async () => {
    for (const table of ["deduped_activities", "deduped_sensor", "sensor_scalar_sample", "probe"])
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
  });

  it("drains 65 dirty activities in batches of 32 despite newly arriving keys", async () => {
    await applyMigration();
    await insertPerformanceActivities(
      client,
      database,
      Array.from({ length: 65 }, (_, index) => index + 1),
    );
    await insertPerformanceSensor(client, database, "2026-09-01 12:30:00");
    const completed = new Set<string>();
    for (let cycle = 0; cycle < 3; cycle++) {
      const selected = await keys();
      expect(selected.length).toBeLessThanOrEqual(32);
      for (const key of selected) completed.add(key.activity_id);
      await persistActivityDirtyKeys(client, database, sql);
      if (cycle < 2) await insertPerformanceActivity(client, database, 100 + cycle);
    }
    expect(
      [...Array(65)].every((_, index) => completed.has(activityPerformanceId(index + 1))),
    ).toBe(true);
    expect(await keys()).toEqual([]);
  });

  it("bounds the first build at 32 keys when the target does not exist", async () => {
    await insertPerformanceActivities(
      client,
      database,
      Array.from({ length: 65 }, (_, index) => index + 1),
      { version: 41 },
    );
    await client.command({ query: `RENAME TABLE ${database}.probe TO ${database}.probe_saved` });
    try {
      const initialSql = await compileActivityDirtyKeys(database);
      const result = await client.query({
        query: `SELECT * REPLACE(toString(source_sensor_version) AS source_sensor_version)
          FROM (${initialSql}) SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
        format: "JSONEachRow",
      });
      const initial = z.array(dirtyKeySchema).parse(await result.json());
      expect(initial.map((row) => row.activity_id)).toEqual(
        Array.from({ length: 32 }, (_, index) => activityPerformanceId(index + 1)),
      );
      expect(initial.every((row) => row.user_id === activityPerformanceUserId)).toBe(true);
      expect(initial.every((row) => row.source_activity_version === 41)).toBe(true);
      expect(initial.every((row) => row.source_sensor_version === "0")).toBe(true);
      expect(
        initial.every((row) => row.prior_started_at === null && row.prior_ended_at === null),
      ).toBe(true);
    } finally {
      await client.command({ query: `RENAME TABLE ${database}.probe_saved TO ${database}.probe` });
    }
  });

  it.each(["table", "incremental"])(
    "preserves zero UUID presence and excludes unseen deletions in the initial %s branch",
    async (materialized) => {
      const zero = "00000000-0000-0000-0000-000000000000";
      await client.insert({
        table: `${database}.deduped_activities`,
        format: "JSONEachRow",
        values: [0, 1].map((deleted) => ({
          user_id: zero,
          activity_id: deleted ? activityPerformanceId(2) : zero,
          started_at: "2026-09-01 12:00:00",
          ended_at: null,
          member_activity_ids: [],
          refresh_version: 0,
          is_deleted: deleted,
        })),
      });
      await client.command({ query: `RENAME TABLE ${database}.probe TO ${database}.probe_saved` });
      try {
        const initialSql = await compileActivityPerformanceModel(
          database,
          "probe",
          `{{ config(materialized='${materialized}') }}\n{{ activity_sensor_dirty_keys('heart_rate', this) }}`,
        );
        expect(await keys(initialSql)).toEqual([
          {
            user_id: zero,
            activity_id: zero,
            canonical_type: "running",
            started_at: "2026-09-01 12:00:00.000000",
            ended_at: "2026-09-02 00:00:00.000000",
            prior_started_at: null,
            prior_ended_at: null,
            source_activity_version: 0,
            source_sensor_version: "0",
            source_is_deleted: 0,
          },
        ]);
      } finally {
        await client.command({
          query: `RENAME TABLE ${database}.probe_saved TO ${database}.probe`,
        });
      }
    },
  );

  it("distinguishes matched zero-clock markers, same activity UUID across users and prior-only disappearance", async () => {
    const zero = "00000000-0000-0000-0000-000000000000";
    const disappeared = activityPerformanceId(3);
    const deleted = activityPerformanceId(4);
    await client.insert({
      table: `${database}.deduped_activities`,
      format: "JSONEachRow",
      values: [
        [zero, zero, 0],
        [activityPerformanceUserId, zero, 0],
        [zero, deleted, 1],
      ].map(([user, activity, isDeleted]) => ({
        user_id: user,
        activity_id: activity,
        started_at: "2026-09-01 12:00:00",
        ended_at: "2026-09-01 13:00:00",
        member_activity_ids: [],
        refresh_version: 0,
        is_deleted: isDeleted,
      })),
    });
    await client.insert({
      table: `${database}.probe`,
      format: "JSONEachRow",
      values: [zero, disappeared, deleted].map((activity) => ({
        user_id: zero,
        activity_id: activity,
        canonical_type: "running",
        started_at: "2026-09-01 12:00:00",
        ended_at: "2026-09-01 13:00:00",
        source_activity_version: 0,
        source_sensor_version: 0,
        refresh_version: 0,
        is_deleted: 0,
      })),
    });
    const selected = await keys();
    expect(selected.map((row) => [row.user_id, row.activity_id, row.source_is_deleted])).toEqual([
      [zero, disappeared, 1],
      [zero, deleted, 1],
      [activityPerformanceUserId, zero, 0],
    ]);
    expect(
      selected.every(
        (row) => row.source_activity_version === 0 && row.source_sensor_version === "0",
      ),
    ).toBe(true);
    expect(selected.find((row) => row.user_id === activityPerformanceUserId)).toMatchObject({
      prior_started_at: null,
      prior_ended_at: null,
    });
    await persistActivityDirtyKeys(client, database, sql);
    expect(await keys()).toEqual([]);
  });

  it("persists both normalized probe endpoints as nonnullable current-schema columns", async () => {
    const result = await client.query({
      query: `DESCRIBE TABLE ${database}.probe`,
      format: "JSONEachRow",
    });
    const columns = await result.json<{ name: string; type: string }>();
    expect(
      columns.filter(({ name }) => name === "started_at" || name === "ended_at"),
    ).toMatchObject([
      { name: "started_at", type: "DateTime64(6, 'UTC')" },
      { name: "ended_at", type: "DateTime64(6, 'UTC')" },
    ]);
  });

  it.each(["activity_pace_curve", "activity_heart_rate_distribution"])(
    "creates nonnullable normalized endpoints with the canonical initial %s writer",
    async (model) => {
      await insertPerformanceActivity(client, database, 1, { endedAt: null, version: 41 });
      const source = await readFile(new URL(`./${model}.sql`, import.meta.url), "utf8");
      await runActivityPerformanceModel(database, model, source);
      const result = await client.query({
        query: `DESCRIBE TABLE ${database}.${model}`,
        format: "JSONEachRow",
      });
      const columns = await result.json<{ name: string; type: string }>();
      expect(
        columns.filter(({ name }) => name === "started_at" || name === "ended_at"),
      ).toMatchObject([
        { name: "started_at", type: "DateTime64(6, 'UTC')" },
        { name: "ended_at", type: "DateTime64(6, 'UTC')" },
      ]);
      const rows = await client.query({
        query: `SELECT DISTINCT user_id, activity_id, started_at, ended_at,
        toString(source_activity_version) AS source_activity_version, toString(source_sensor_version) AS source_sensor_version
        FROM ${database}.${model} FINAL`,
        format: "JSONEachRow",
      });
      expect(await rows.json()).toEqual([
        {
          user_id: activityPerformanceUserId,
          activity_id: activityPerformanceId(1),
          started_at: "2026-09-01 12:00:00.000000",
          ended_at: "2026-09-02 00:00:00.000000",
          source_activity_version: "41",
          source_sensor_version: "0",
        },
      ]);
    },
  );

  it.each([
    {
      name: "absent prior and inclusive midnight",
      start: "2026-09-01 23:55:00",
      end: "2026-09-02 00:00:00",
      prior: null,
      days: [
        ["2026-09-01", 101],
        ["2026-09-02", 202],
        ["2026-09-03", 999],
      ],
      expected: "202",
    },
    {
      name: "identical windows",
      start: "2026-09-01 12:00:00",
      end: "2026-09-01 13:00:00",
      prior: ["2026-09-01 12:00:00", "2026-09-01 13:00:00"],
      days: [
        ["2026-09-01", 101],
        ["2026-09-02", 999],
      ],
      expected: "101",
    },
    {
      name: "overlapping windows",
      start: "2026-09-02 00:00:00",
      end: "2026-09-03 00:00:00",
      prior: ["2026-09-01 23:55:00", "2026-09-02 00:10:00"],
      days: [
        ["2026-09-01", 202],
        ["2026-09-02", 101],
        ["2026-09-03", 303],
        ["2026-09-04", 999],
      ],
      expected: "303",
    },
    {
      name: "disjoint prior-day maximum",
      start: "2026-09-03 12:00:00",
      end: "2026-09-03 13:00:00",
      prior: ["2026-09-01 12:00:00", "2026-09-01 13:00:00"],
      days: [
        ["2026-09-01", 303],
        ["2026-09-02", 999],
        ["2026-09-03", 202],
      ],
      expected: "303",
    },
    {
      name: "disjoint current-day maximum",
      start: "2026-09-03 12:00:00",
      end: "2026-09-03 13:00:00",
      prior: ["2026-09-01 12:00:00", "2026-09-01 13:00:00"],
      days: [
        ["2026-09-01", 101],
        ["2026-09-02", 999],
        ["2026-09-03", 303],
      ],
      expected: "303",
    },
    {
      name: "prior marker sensor maximum",
      start: "2026-09-03 12:00:00",
      end: "2026-09-03 13:00:00",
      prior: ["2026-09-01 12:00:00", "2026-09-01 13:00:00"],
      days: [
        ["2026-09-01", 1],
        ["2026-09-03", 2],
      ],
      expected: "5",
    },
    {
      name: "reversed end retains only start day",
      start: "2026-09-02 14:00:00",
      end: "2026-09-01 13:00:00",
      prior: null,
      days: [
        ["2026-09-01", 999],
        ["2026-09-02", 101],
      ],
      expected: "101",
    },
    {
      name: "open end normalized twelve hours",
      start: "2026-09-01 12:00:00",
      end: null,
      prior: null,
      days: [
        ["2026-09-01", 101],
        ["2026-09-02", 202],
        ["2026-09-03", 999],
      ],
      expected: "202",
    },
  ])(
    "uses independent covered-day maxima for $name",
    async ({ start, end, prior, days, expected }) => {
      await insertPerformanceActivity(client, database, 1, {
        startedAt: start,
        endedAt: end,
        version: 2,
      });
      if (prior)
        await client.insert({
          table: `${database}.probe`,
          format: "JSONEachRow",
          values: [
            {
              user_id: activityPerformanceUserId,
              activity_id: activityPerformanceId(1),
              canonical_type: "running",
              started_at: prior[0],
              ended_at: prior[1],
              source_activity_version: 1,
              source_sensor_version: 5,
              refresh_version: 10,
              is_deleted: 0,
            },
          ],
        });
      await client.insert({
        table: `${database}.deduped_sensor`,
        format: "JSONEachRow",
        values: days.map(([day, version]) => ({
          user_id: activityPerformanceUserId,
          channel: "heart_rate",
          recorded_at: `${day} 12:00:00`,
          scalar: 120,
          refresh_version: version,
          is_deleted: 0,
        })),
      });
      expect(await keys()).toEqual([
        {
          user_id: activityPerformanceUserId,
          activity_id: activityPerformanceId(1),
          canonical_type: "running",
          started_at: `${start}.000000`,
          ended_at: `${end ?? "2026-09-02 00:00:00"}.000000`,
          prior_started_at: prior ? `${prior[0]}.000000` : null,
          prior_ended_at: prior ? `${prior[1]}.000000` : null,
          source_activity_version: 2,
          source_sensor_version: expected,
          source_is_deleted: 0,
        },
      ]);
    },
  );

  it("selects 32 distinct activities when the persisted target has all 12 pace durations", async () => {
    await insertPerformanceActivity(client, database, 1);
    await persistActivityDirtyKeys(client, database, sql);
    await client.command({
      query: `INSERT INTO ${database}.probe
      SELECT user_id, activity_id, canonical_type, started_at, ended_at, source_activity_version,
        source_sensor_version, if(duration > 6, 1, 0), refresh_version, duration * 60
      FROM ${database}.probe FINAL ARRAY JOIN range(1, 13) AS duration`,
    });
    await client.command({
      query: `ALTER TABLE ${database}.probe DELETE WHERE duration_seconds = 0 SETTINGS mutations_sync = 2`,
    });
    await insertPerformanceActivities(
      client,
      database,
      Array.from({ length: 64 }, (_, index) => index + 2),
    );
    await insertPerformanceSensor(client, database, "2026-09-01 12:00:00");
    const selected = await keys();
    expect(selected).toHaveLength(32);
    expect(new Set(selected.map((key) => key.activity_id)).size).toBe(32);
    expect(selected.filter((key) => key.activity_id === activityPerformanceId(1))).toHaveLength(1);
  });

  it.each([false, true])(
    "advances an older processed dirty key despite full batches of arrivals (shared day=%s)",
    async (sharedDay) => {
      const oldDate = sharedDay ? "2026-09-01" : "2026-08-01";
      await insertPerformanceActivity(client, database, 1000, {
        startedAt: `${oldDate} 12:00:00`,
        endedAt: `${oldDate} 13:00:00`,
      });
      await persistActivityDirtyKeys(client, database, sql);
      await insertPerformanceSensor(client, database, `${oldDate} 12:00:00`);
      let completed = false;
      for (let cycle = 0; cycle < 3; cycle++) {
        await insertPerformanceActivities(
          client,
          database,
          Array.from({ length: 32 }, (_, offset) => cycle * 32 + offset + 1),
          {
            startedAt: "2026-09-01 12:00:00",
            endedAt: "2026-09-01 13:00:00",
          },
        );
        await insertPerformanceSensor(client, database, "2026-09-01 12:00:00");
        const selected = await keys();
        expect(selected).toHaveLength(32);
        completed ||= selected.some((row) => row.activity_id === activityPerformanceId(1000));
        await persistActivityDirtyKeys(client, database, sql);
      }
      expect(completed).toBe(true);
    },
  );

  it("advances an older never-processed key despite lower-UUID arrivals and shared-day refreshes", async () => {
    await insertPerformanceActivity(client, database, 1000);
    let completed = false;
    for (let cycle = 0; cycle < 3; cycle++) {
      await insertPerformanceActivities(
        client,
        database,
        Array.from({ length: 32 }, (_, offset) => cycle * 32 + offset + 1),
      );
      await insertPerformanceSensor(client, database, "2026-09-01 12:00:00");
      const selected = await keys();
      expect(selected).toHaveLength(32);
      expect(new Set(selected.map((key) => key.activity_id)).size).toBe(32);
      completed ||= selected.some((key) => key.activity_id === activityPerformanceId(1000));
      await persistActivityDirtyKeys(client, database, sql);
    }
    expect(completed).toBe(true);
  });

  it("keeps a processed-empty window clean until a real source arrival", async () => {
    await insertPerformanceActivity(client, database, 1);
    expect(await keys()).toHaveLength(1);
    await persistActivityDirtyKeys(client, database, sql);
    expect(await keys()).toEqual([]);
    await insertPerformanceSensor(client, database, "2026-09-01 12:20:00");
    expect(await keys()).toHaveLength(1);
    await persistActivityDirtyKeys(client, database, sql);
    expect(await keys()).toEqual([]);
  });

  it("keeps a live but processed-ineligible tombstone stable until its activity type changes", async () => {
    await insertPerformanceActivity(client, database, 1, { canonicalType: "climbing", version: 1 });
    await persistActivityDirtyKeys(client, database, sql);
    await client.command({
      query: `ALTER TABLE ${database}.probe UPDATE is_deleted = 1
      WHERE 1 SETTINGS mutations_sync = 2`,
    });
    expect(await keys()).toEqual([]);
    await insertPerformanceActivity(client, database, 1, { canonicalType: "running", version: 2 });
    expect(await keys()).toMatchObject([{ canonical_type: "running", source_is_deleted: 0 }]);
  });

  it("detects source-priority changes after the established explicit canonical replay", async () => {
    await insertPerformanceActivity(client, database, 1);
    await client.command({
      query: `INSERT INTO ${database}.sensor_scalar_sample
      (id, user_id, recorded_at, channel, scalar, provider_id, provider_priority) VALUES
      ('${activityPerformanceId(301)}', '${activityPerformanceUserId}', '2026-09-01 12:00:00', 'heart_rate', 110, 'first', 1),
      ('${activityPerformanceId(302)}', '${activityPerformanceUserId}', '2026-09-01 12:00:00', 'heart_rate', 140, 'second', 2)`,
    });
    await refreshPerformanceCanonicalSensors(client, database);
    await persistActivityDirtyKeys(client, database, sql);
    expect(await keys()).toEqual([]);
    await client.command({
      query: `ALTER TABLE ${database}.sensor_scalar_sample
      UPDATE provider_priority = 0 WHERE provider_id = 'second' SETTINGS mutations_sync = 2`,
    });
    await refreshPerformanceCanonicalSensors(client, database);
    const selected = await client.query({
      query: `SELECT scalar, provider_id FROM ${database}.deduped_sensor FINAL`,
      format: "JSONEachRow",
    });
    expect(await selected.json()).toEqual([{ scalar: 140, provider_id: "second" }]);
    expect(await keys()).toHaveLength(1);
    await persistActivityDirtyKeys(client, database, sql);
    expect(await keys()).toEqual([]);
  });

  it("compares activity and sensor versions separately and ignores unrelated user/channel/day arrivals", async () => {
    await insertPerformanceActivity(client, database, 1, { version: 1 });
    await insertPerformanceSensor(client, database, "2026-09-01 12:20:00");
    await persistActivityDirtyKeys(client, database, sql);
    await insertPerformanceSensor(client, database, "2026-09-01 12:20:00", { channel: "speed" });
    await insertPerformanceSensor(client, database, "2026-09-01 12:20:00", {
      userId: activityPerformanceId(200),
    });
    await insertPerformanceSensor(client, database, "2026-09-10 12:20:00");
    expect(await keys()).toEqual([]);
    await insertPerformanceActivity(client, database, 1, { version: 2, canonicalType: "walking" });
    expect(await keys()).toMatchObject([{ source_activity_version: 2, canonical_type: "walking" }]);
  });

  it("includes prior and current windows and advances a covered day's scalar maximum in the real writer lifecycle", async () => {
    await insertPerformanceActivity(client, database, 1, {
      startedAt: "2026-09-01 23:55:00",
      endedAt: "2026-09-02 00:10:00",
    });
    await insertPerformanceSensor(client, database, "2026-09-01 23:59:00");
    await insertPerformanceSensor(client, database, "2026-09-02 00:00:00");
    const initial = await keys();
    await persistActivityDirtyKeys(client, database, sql);
    await insertPerformanceSensor(client, database, "2026-09-01 23:59:00", { provider: "second" });
    const changed = await keys();
    expect(BigInt(changed[0]?.source_sensor_version ?? 0)).toBeGreaterThan(
      BigInt(initial[0]?.source_sensor_version ?? 0),
    );
    await persistActivityDirtyKeys(client, database, sql);
    await insertPerformanceActivity(client, database, 1, {
      startedAt: "2026-09-03 09:00:00",
      endedAt: "2026-09-03 10:00:00",
    });
    expect(await keys()).toMatchObject([
      {
        started_at: "2026-09-03 09:00:00.000000",
        ended_at: "2026-09-03 10:00:00.000000",
        prior_started_at: "2026-09-01 23:55:00.000000",
        prior_ended_at: "2026-09-02 00:10:00.000000",
      },
    ]);
    await persistActivityDirtyKeys(client, database, sql);
    expect(await keys()).toEqual([]);
    await insertPerformanceSensor(client, database, "2026-09-03 09:10:00");
    expect(await keys()).toHaveLength(1);
  });

  it("reconciles deletion, stable tombstones, resurrection, merge and split canonical keys", async () => {
    await insertPerformanceActivity(client, database, 1, { version: 1 });
    await insertPerformanceActivity(client, database, 2, { version: 2 });
    await persistActivityDirtyKeys(client, database, sql);
    await insertPerformanceActivity(client, database, 1, { version: 3, deleted: 1 });
    await insertPerformanceActivity(client, database, 2, {
      version: 4,
      members: [activityPerformanceId(1001), activityPerformanceId(1002)],
    });
    expect(await keys()).toMatchObject([
      { activity_id: activityPerformanceId(1), source_is_deleted: 1 },
      { activity_id: activityPerformanceId(2), source_is_deleted: 0 },
    ]);
    await persistActivityDirtyKeys(client, database, sql);
    await insertPerformanceSensor(client, database, "2026-09-01 12:00:00");
    expect((await keys()).map((row) => row.activity_id)).toEqual([activityPerformanceId(2)]);
    await persistActivityDirtyKeys(client, database, sql);
    await insertPerformanceActivity(client, database, 1, { version: 5 });
    await insertPerformanceActivity(client, database, 2, { version: 6 });
    expect((await keys()).map((row) => row.activity_id).sort()).toEqual([
      activityPerformanceId(1),
      activityPerformanceId(2),
    ]);
    await persistActivityDirtyKeys(client, database, sql);
    expect(await keys()).toEqual([]);
    await client.command({ query: `TRUNCATE TABLE ${database}.deduped_activities` });
    expect((await keys()).every((row) => row.source_is_deleted === 1)).toBe(true);
    await persistActivityDirtyKeys(client, database, sql);
    expect(await keys()).toEqual([]);
  });

  it("uses UTC calendar bounds through DST and includes the inclusive midnight endpoint", async () => {
    await insertPerformanceActivity(client, database, 1, {
      startedAt: "2026-11-01 08:30:00",
      endedAt: "2026-11-02 00:00:00",
    });
    await persistActivityDirtyKeys(client, database, sql);
    await insertPerformanceSensor(client, database, "2026-11-02 00:00:00");
    expect(await keys()).toHaveLength(1);
    await persistActivityDirtyKeys(client, database, sql);
    expect(await keys()).toEqual([]);
  });

  it("preserves the request's exact reversed end bound while bounding calendar enumeration", async () => {
    await insertPerformanceActivity(client, database, 1, {
      startedAt: "2026-09-02 14:00:00",
      endedAt: "2026-09-01 13:00:00",
    });
    expect(await keys()).toMatchObject([
      {
        started_at: "2026-09-02 14:00:00.000000",
        ended_at: "2026-09-01 13:00:00.000000",
      },
    ]);
    await persistActivityDirtyKeys(client, database, sql);
    expect(await keys()).toEqual([]);
  });
});
