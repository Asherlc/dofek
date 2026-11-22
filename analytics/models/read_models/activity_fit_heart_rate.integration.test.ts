import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { renderDbtModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";
import {
  activityPerformanceId,
  activityPerformanceUserId,
  insertPerformanceActivities,
} from "./activity-performance-test-helpers.ts";

const countSchema = z.coerce.number();
const rowSchema = z.object({
  activity_id: z.string(),
  member_activity_id: z.string().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  status: z.string(),
  covered_seconds: countSchema,
  bpm_seconds: z.array(z.tuple([z.number(), countSchema])),
  is_deleted: z.number(),
  source_sensor_version: countSchema,
  source_member_version: z.coerce.string(),
  refresh_version: z.coerce.string(),
});

describe("activity_fit_heart_rate", () => {
  const database = `fit_heart_rate_${randomUUID().replaceAll("-", "")}`;
  const url = process.env.CLICKHOUSE_URL;
  if (!url) throw new Error("CLICKHOUSE_URL is required");
  const client = createClient({ url });
  let modelSql: string;

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.deduped_activities (
        user_id UUID, activity_id UUID, canonical_type String, provider_type Nullable(String),
        started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')),
        member_activity_ids Array(UUID), refresh_version UInt64 DEFAULT 1, is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.deduped_activity_members (
        user_id UUID, activity_id UUID, member_activity_id UUID,
        refresh_version UInt64, is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, member_activity_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.activity_source_records (
        user_id UUID, activity_id UUID, provider_id String, raw Nullable(String),
        started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')),
        source_synced_at Nullable(DateTime64(9, 'UTC')), refresh_version UInt64, is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.activity_sensor_sample (
        user_id UUID, activity_id UUID, recorded_at DateTime64(6, 'UTC'), channel String,
        scalar Nullable(Float64), provider_id String, member_activity_id Nullable(UUID),
        source_type Nullable(String), measurement_kind Nullable(String),
        refresh_version UInt64, is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, channel, recorded_at)`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.activity_fit_heart_rate (
        user_id UUID, activity_id UUID, member_activity_id Nullable(UUID),
        started_at Nullable(DateTime64(6, 'UTC')), ended_at Nullable(DateTime64(6, 'UTC')),
        status String, covered_seconds UInt64, bpm_seconds Array(Tuple(Float64, UInt64)),
        is_deleted UInt8, source_sensor_version UInt64, refresh_version UInt64,
        source_activity_version UInt64, source_member_version UInt64
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    });
    const source = await readFile(new URL("./activity_fit_heart_rate.sql", import.meta.url), "utf8");
    modelSql = renderDbtModelSql(source, { isIncremental: true })
      .replaceAll(/\{\{ ref\('([a-z_]+)'\) \}\}/g, `${database}.$1`)
      .replaceAll("{{ this }}", `${database}.activity_fit_heart_rate`);
    await seed();
    await build();
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  async function build() {
    await client.command({
      query: `INSERT INTO ${database}.activity_fit_heart_rate ${modelSql}
        SETTINGS max_threads = 1, join_use_nulls = 1, enable_materialized_cte = 1`,
    });
  }

  async function rows() {
    const result = await client.query({
      query: `SELECT * FROM ${database}.activity_fit_heart_rate FINAL ORDER BY activity_id`,
      format: "JSONEachRow",
    });
    return z.array(rowSchema).parse(await result.json());
  }

  function fitMember(index: number, options: { fractional?: boolean; deleted?: boolean; missingSession?: boolean } = {}) {
    const fraction = options.fractional ? ".250" : "";
    return {
      user_id: activityPerformanceUserId,
      activity_id: activityPerformanceId(index + 1000),
      provider_id: "fit-file",
      raw: JSON.stringify({
        fitPath: "workout.fit",
        session: options.missingSession
          ? null
          : { start_time: `2026-09-01T12:00:00${fraction}Z`, total_elapsed_time: 1800 },
      }),
      started_at: `2026-09-01 12:00:00${fraction}`,
      ended_at: `2026-09-01 12:30:00${fraction}`,
      source_synced_at: options.missingSession ? "2026-09-02 12:30:01" : "2026-09-01 12:30:01",
      refresh_version: options.deleted ? 3 : 1,
      is_deleted: options.deleted ? 1 : 0,
    };
  }

  async function seed() {
    // These older unrelated groups must never consume the limited FIT dirty batch.
    await insertPerformanceActivities(
      client,
      database,
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
    const fitGroups = [41, 42, 43, 44, 45, 46, 47, 48, 49];
    await client.insert({
      table: `${database}.deduped_activities`,
      format: "JSONEachRow",
      values: fitGroups.map((index) => ({
        user_id: activityPerformanceUserId,
        activity_id: activityPerformanceId(index),
        canonical_type: "running",
        started_at: "2026-09-01 11:55:00",
        ended_at: "2026-09-01 12:35:00",
        member_activity_ids: [
          activityPerformanceId(index + 1000),
          ...(index === 46 ? [activityPerformanceId(3000)] : []),
          ...(index === 49 ? [activityPerformanceId(3001)] : []),
        ],
        is_deleted: 0,
      })),
    });
    await client.insert({
      table: `${database}.deduped_activity_members`,
      format: "JSONEachRow",
      values: [
        ...fitGroups.map((index) => ({ group: index, member: index + 1000 })),
        { group: 46, member: 3000 },
        { group: 49, member: 3001 },
      ].map(({ group, member }) => ({
        user_id: activityPerformanceUserId,
        activity_id: activityPerformanceId(group),
        member_activity_id: activityPerformanceId(member),
        refresh_version: 1,
        is_deleted: 0,
      })),
    });
    await client.insert({
      table: `${database}.activity_source_records`,
      format: "JSONEachRow",
      values: [
        ...fitGroups.map((index) => fitMember(index, { fractional: index === 45 })),
        fitMember(2000),
        fitMember(2001, { missingSession: true }),
      ],
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_sensor_sample
        SELECT
          toUUID('${activityPerformanceUserId}'), toUUID(concat('00000000-0000-4000-8000-', leftPad(toString(group_id), 12, '0'))),
          addMicroseconds(addSeconds(toDateTime64('2026-09-01 12:00:00', 6, 'UTC'), number),
            if(group_id = 43 AND number = 120, 100000, 0)),
          'heart_rate', if(number < 1800, 130, 250),
          if(group_id = 44 AND number = 120, 'other', 'fit-file'),
          toUUID(concat('00000000-0000-4000-8000-', leftPad(toString(if(group_id = 47, 9000, group_id + 1000)), 12, '0'))),
          if(group_id = 44 AND number = 120, 'api', 'file'),
          if(group_id = 48 AND number = 120, 'estimated', 'unknown'), 10, 0
        FROM numbers(1801) AS seconds
        CROSS JOIN (SELECT arrayJoin([${fitGroups.join(", ")}]) AS group_id) AS workouts
        WHERE NOT (group_id = 42 AND number = 120)`,
    });
  }

  it("accepts only complete one-second grids inside the original FIT bounds", async () => {
    const initial = await rows();
    expect(initial).toHaveLength(9);
    expect(initial[0]).toMatchObject({
      activity_id: activityPerformanceId(41),
      member_activity_id: activityPerformanceId(1041),
      started_at: "2026-09-01 12:00:00.000000",
      ended_at: "2026-09-01 12:30:00.000000",
      status: "complete",
      covered_seconds: 1800,
      bpm_seconds: [[130, 1800]],
      is_deleted: 0,
    });
    expect(initial.slice(1, 8).map((row) => row.status)).not.toContain("complete");
    expect(initial.slice(1, 8).map((row) => row.bpm_seconds)).toEqual(Array.from({ length: 7 }, () => []));
  });

  it("preserves evidence across an unchanged source projection rewrite", async () => {
    const initial = await rows();
    await client.insert({
      table: `${database}.activity_source_records`,
      format: "JSONEachRow",
      values: [{ ...fitMember(41), refresh_version: 2 }],
    });
    await build();
    expect((await rows())[0]?.refresh_version).toBe(initial[0]?.refresh_version);
  });

  it("keeps the selected FIT member's own source version alongside a newer invalid member", async () => {
    expect((await rows()).find(({ activity_id }) => activity_id === activityPerformanceId(49))).toMatchObject({
      member_activity_id: activityPerformanceId(1049),
      status: "complete",
      source_member_version: String(BigInt(Date.parse("2026-09-01T12:30:01Z")) * 1_000_000n),
      bpm_seconds: [[130, 1800]],
    });
  });

  it("invalidates a complete grid when a surviving sample is deleted", async () => {
    await client.command({
      query: `INSERT INTO ${database}.activity_sensor_sample
        SELECT * REPLACE (toUInt64(11) AS refresh_version, toUInt8(1) AS is_deleted)
        FROM ${database}.activity_sensor_sample FINAL
        WHERE activity_id = toUUID('${activityPerformanceId(49)}')
          AND recorded_at = toDateTime64('2026-09-01 12:00:10', 6, 'UTC')`,
    });
    await build();
    expect((await rows()).find(({ activity_id }) => activity_id === activityPerformanceId(49))).toMatchObject({
      status: "incomplete",
      covered_seconds: 1799,
      bpm_seconds: [],
      source_sensor_version: 11,
    });
  });

  it("reconciles FIT source removal and canonical membership corrections", async () => {
    await client.insert({
      table: `${database}.activity_source_records`,
      format: "JSONEachRow",
      values: [fitMember(41, { deleted: true })],
    });
    await client.command({
      query: `INSERT INTO ${database}.deduped_activity_members
        SELECT * REPLACE (toUInt64(2) AS refresh_version, toUInt8(1) AS is_deleted)
        FROM ${database}.deduped_activity_members FINAL
        WHERE member_activity_id = toUUID('${activityPerformanceId(3000)}')`,
    });
    await build();
    const corrected = await rows();
    expect(corrected[0]).toMatchObject({ is_deleted: 1, bpm_seconds: [] });
    expect(corrected.find(({ activity_id }) => activity_id === activityPerformanceId(46))).toMatchObject({
      member_activity_id: activityPerformanceId(1046),
      status: "complete",
      bpm_seconds: [[130, 1800]],
    });
  });
});
