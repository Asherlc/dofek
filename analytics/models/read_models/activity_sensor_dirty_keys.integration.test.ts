import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { clickHouseMigrations } from "../../../src/db/clickhouse-migrations/registry.ts";
import {
  activityPerformanceId,
  activityPerformanceUserId,
  compileActivityDirtyKeys,
  createActivityPerformanceFixture,
  insertPerformanceActivities,
  insertPerformanceActivity,
  insertPerformanceSensor,
  persistActivityDirtyKeys,
  refreshPerformanceCanonicalSensors,
} from "./activity-performance-test-helpers.ts";

const dirtyKeySchema = z.object({
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
  async function keys() {
    const result = await client.query({
      query: `SELECT * REPLACE(toString(source_sensor_version) AS source_sensor_version)
        FROM (${sql}) SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
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
    );
    await client.command({ query: `RENAME TABLE ${database}.probe TO ${database}.probe_saved` });
    try {
      const initialSql = await compileActivityDirtyKeys(database);
      const result = await client.query({
        query: `${initialSql}\nSETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
        format: "JSONEachRow",
      });
      expect(await result.json()).toHaveLength(32);
    } finally {
      await client.command({ query: `RENAME TABLE ${database}.probe_saved TO ${database}.probe` });
    }
  });

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
