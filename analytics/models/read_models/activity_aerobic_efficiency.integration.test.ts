import { randomUUID } from "node:crypto";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AccessWindow } from "../../../packages/server/src/billing/entitlement.ts";
import { ChartRange } from "../../../packages/server/src/lib/chart-range.ts";
import { ClickHouseActivitySensorStore } from "../../../packages/server/src/repositories/clickhouse-activity-sensor-store.ts";
import { EfficiencyRepository } from "../../../packages/server/src/repositories/efficiency-repository.ts";
import { readModelSql, renderDbtModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";

describe.each(["model", "live"])("aerobic efficiency elapsed-time eligibility (%s)", (path) => {
  const database = `aerobic_efficiency_${randomUUID().replaceAll("-", "")}`;
  const userId = randomUUID();
  let client: ClickHouseClient;

  beforeAll(async () => {
    if (!process.env.CLICKHOUSE_URL) throw new Error("CLICKHOUSE_URL is required");
    client = createClient({ url: process.env.CLICKHOUSE_URL });
    await client.command({ query: `CREATE DATABASE ${database}` });
    for (const [table, columns, key] of [
      [
        "activity_summary_rows",
        `activity_id UUID, user_id UUID, canonical_type String,
        name String, started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')),
        is_deleted UInt8`,
        "(user_id, activity_id)",
      ],
      [
        "resting_heart_rate_sleep_window",
        `user_id UUID, resting_hr Nullable(Float64),
        ended_at Nullable(DateTime64(6, 'UTC')), duration_seconds Int64 DEFAULT 0, is_deleted UInt8`,
        "user_id",
      ],
      [
        "user_profile_current",
        "id UUID, max_hr Nullable(Float64), resting_hr Nullable(Float64)",
        "id",
      ],
      [
        "activity_sensor_sample",
        `activity_id UUID, user_id UUID, recorded_at DateTime64(6, 'UTC'),
        channel String, scalar Nullable(Float64), is_deleted UInt8`,
        "(user_id, activity_id, channel, recorded_at)",
      ],
    ]) {
      await client.command({
        query: `CREATE TABLE ${database}.${table} (${columns})
          ENGINE = ReplacingMergeTree ORDER BY ${key}`,
      });
    }
    for (const [view, select] of [
      ["activity_summary", `SELECT * FROM ${database}.activity_summary_rows`],
      ["v_activity", `SELECT activity_id AS id, user_id FROM ${database}.activity_summary_rows`],
      ["deduped_sensor", `SELECT * FROM ${database}.activity_sensor_sample`],
    ]) {
      await client.command({ query: `CREATE VIEW ${database}.${view} AS ${select}` });
    }
    await client.command({
      query: `CREATE TABLE ${database}.activity_aerobic_efficiency (
      user_id UUID, max_hr Float64, started_at DateTime64(6, 'UTC'), canonical_type String,
      name String, avg_power_z2 Float64, avg_hr_z2 Float64, efficiency_factor Float64,
      z2_samples Int32, is_deleted UInt8
    ) ENGINE = ReplacingMergeTree ORDER BY user_id`,
    });
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client?.close();
  });

  async function compute(
    offsets: number[],
    options: {
      heartRate?: (offset: number) => number;
      power?: (offset: number) => number | null;
      powerPresent?: (offset: number) => boolean;
      powerOffsets?: number[];
      maxHr?: number;
      restingHr?: number;
      accessWindow?: AccessWindow;
    } = {},
  ) {
    await client.command({ query: `TRUNCATE TABLE ${database}.activity_summary_rows` });
    await client.command({ query: `TRUNCATE TABLE ${database}.activity_sensor_sample` });
    await client.command({ query: `TRUNCATE TABLE ${database}.activity_aerobic_efficiency` });
    await client.command({ query: `TRUNCATE TABLE ${database}.user_profile_current` });
    await client.insert({
      table: `${database}.user_profile_current`,
      format: "JSONEachRow",
      values: [{ id: userId, max_hr: options.maxHr ?? 200, resting_hr: options.restingHr ?? 50 }],
    });
    const activityId = randomUUID();
    const start = new Date("2026-02-10T00:00:00Z").getTime();
    const timestamp = (offset: number) =>
      new Date(start + offset * 1000).toISOString().replace("T", " ").replace("Z", "");
    await client.insert({
      table: `${database}.activity_summary_rows`,
      format: "JSONEachRow",
      values: [
        {
          activity_id: activityId,
          user_id: userId,
          canonical_type: "cycling",
          name: "Ride",
          started_at: timestamp(0),
          ended_at: timestamp(Math.max(offsets.at(-1) ?? 0, options.powerOffsets?.at(-1) ?? 0)),
          is_deleted: 0,
        },
      ],
    });
    await client.insert({
      table: `${database}.activity_sensor_sample`,
      format: "JSONEachRow",
      values: [
        ...offsets.map((offset) => ({
          activity_id: activityId,
          user_id: userId,
          recorded_at: timestamp(offset),
          channel: "heart_rate",
          scalar: options.heartRate?.(offset) ?? 145,
          is_deleted: 0,
        })),
        ...(options.powerOffsets ?? offsets).flatMap((offset) =>
          options.powerPresent?.(offset) === false
            ? []
            : [
                {
                  activity_id: activityId,
                  user_id: userId,
                  recorded_at: timestamp(offset),
                  channel: "power",
                  scalar: options.power ? options.power(offset) : 200,
                  is_deleted: 0,
                },
              ],
        ),
      ],
    });
    const sql = renderDbtModelSql(readModelSql("activity_aerobic_efficiency.sql"), {
      isIncremental: false,
    })
      .replace(/\{\{\s*ref\('([^']+)'\)\s*\}\}/g, `${database}.$1`)
      .replace(
        "{{ source('postgres_fitness', 'user_profile_current') }}",
        `${database}.user_profile_current`,
      );
    if (path === "model" && options.accessWindow) {
      const columns =
        "user_id, max_hr, started_at, canonical_type, name, avg_power_z2, avg_hr_z2, efficiency_factor, z2_samples, is_deleted";
      await client.command({
        query: `INSERT INTO ${database}.activity_aerobic_efficiency (${columns})
          SELECT ${columns} FROM (${sql}) WHERE is_deleted=0
          SETTINGS join_use_nulls=1, max_threads=1`,
      });
    }
    if (path === "live" || options.accessWindow) {
      const store = new ClickHouseActivitySensorStore({
        command: (params) => client.command(params),
        query: (params) =>
          client.query({
            ...params,
            query: params.query
              .replaceAll("analytics.", `${database}.`)
              .replaceAll("postgres_fitness.", `${database}.`),
            clickhouse_settings: { join_use_nulls: 1, max_threads: 1 },
          }),
      });
      const repo = new EfficiencyRepository(
        { execute: async () => [] },
        userId,
        "UTC",
        store,
        options.accessWindow,
      );
      const result = await repo.getAerobicEfficiency(ChartRange.fromDays(null));
      return result.activities.length
        ? result.activities.map((row) => ({
            avg_power_z2: row.avgPowerZ2,
            avg_hr_z2: row.avgHrZ2,
            efficiency_factor: row.efficiencyFactor,
            z2_samples: row.z2Samples,
            is_deleted: 0,
          }))
        : [{ avg_power_z2: 0, avg_hr_z2: 0, efficiency_factor: 0, z2_samples: 0, is_deleted: 1 }];
    }
    const result = await client.query({
      query: `SELECT avg_power_z2, avg_hr_z2, efficiency_factor, z2_samples, is_deleted FROM (${sql})
        WHERE activity_id = {activityId:UUID} SETTINGS join_use_nulls=1, max_threads=1`,
      query_params: { activityId },
      format: "JSONEachRow",
    });
    return z
      .array(
        z.object({
          avg_power_z2: z.number(),
          avg_hr_z2: z.number(),
          efficiency_factor: z.number(),
          z2_samples: z.number(),
          is_deleted: z.number(),
        }),
      )
      .parse(await result.json());
  }

  it.each([1, 5])("includes exactly five minutes sampled every %i seconds", async (interval) => {
    const rows = await compute(Array.from({ length: 300 / interval + 1 }, (_, i) => i * interval));
    expect(rows).toMatchObject([
      { avg_power_z2: 200, avg_hr_z2: 145, z2_samples: 300 / interval, is_deleted: 0 },
    ]);
  });

  it("excludes less than five minutes even with more than 300 samples", async () => {
    const rows = await compute(Array.from({ length: 599 }, (_, i) => i / 2));
    expect(rows[0]?.is_deleted).toBe(1);
  });

  it("does not count long recording gaps as Zone 2 time", async () => {
    const rows = await compute([0, 5, 10, 3600, 3605, 3610]);
    expect(rows[0]?.is_deleted).toBe(1);
  });

  it("does not bridge time spent outside Zone 2", async () => {
    const rows = await compute(
      Array.from({ length: 121 }, (_, i) => i * 5),
      {
        heartRate: (offset) => (offset < 150 || offset >= 455 ? 145 : 180),
      },
    );
    expect(rows[0]?.is_deleted).toBe(1);
  });

  it("does not carry positive power across zero or missing power", async () => {
    for (const missing of [0, null]) {
      const rows = await compute(
        Array.from({ length: 121 }, (_, i) => i * 5),
        {
          power: (offset) => (offset < 150 ? 200 : missing),
        },
      );
      expect(rows[0]?.is_deleted).toBe(1);
    }
  });

  it("expires stale power instead of pairing it with the rest of the ride", async () => {
    const rows = await compute(
      Array.from({ length: 601 }, (_, i) => i),
      {
        powerPresent: (offset) => offset === 0,
      },
    );
    expect(rows[0]?.is_deleted).toBe(1);
  });

  it("credits at most ten seconds before a long heart-rate gap", async () => {
    const rows = await compute([...Array.from({ length: 291 }, (_, i) => i), 600], {
      powerOffsets: Array.from({ length: 601 }, (_, i) => i),
    });
    expect(rows).toMatchObject([
      { avg_power_z2: 200, avg_hr_z2: 145, z2_samples: 291, is_deleted: 0 },
    ]);
    const belowThreshold = await compute([...Array.from({ length: 290 }, (_, i) => i), 600], {
      powerOffsets: Array.from({ length: 601 }, (_, i) => i),
    });
    expect(belowThreshold[0]?.is_deleted).toBe(1);
  });

  it("weights power and heart rate by elapsed time when cadence changes", async () => {
    const offsets = [
      ...Array.from({ length: 30 }, (_, i) => i * 5),
      ...Array.from({ length: 151 }, (_, i) => 150 + i),
    ];
    const rows = await compute(offsets, {
      power: (offset) => (offset < 150 ? 100 : 300),
      heartRate: (offset) => (offset < 150 ? 140 : 150),
    });
    expect(rows).toMatchObject([
      { avg_power_z2: 200, avg_hr_z2: 145, z2_samples: 180, is_deleted: 0 },
    ]);
  });
  it.each([
    { powerOffsets: Array.from({ length: 301 }, (_, i) => i) },
    { powerOffsets: [0, ...Array.from({ length: 60 }, (_, i) => 2 + i * 5), 300] },
  ])("includes five minutes with independent power timestamps (%#)", async ({ powerOffsets }) => {
    const rows = await compute(
      Array.from({ length: 61 }, (_, i) => i * 5),
      { powerOffsets },
    );
    expect(rows).toMatchObject([
      { avg_power_z2: 200, avg_hr_z2: 145, z2_samples: 60, is_deleted: 0 },
    ]);
  });

  it("credits a final heart-rate reading when power continues through its ten-second hold", async () => {
    const rows = await compute(
      Array.from({ length: 291 }, (_, i) => i),
      {
        powerOffsets: Array.from({ length: 301 }, (_, i) => i),
      },
    );
    expect(rows).toMatchObject([
      { avg_power_z2: 200, avg_hr_z2: 145, z2_samples: 291, is_deleted: 0 },
    ]);
  });

  it("keeps a zero heart-rate denominator finite", async () => {
    const rows = await compute(
      Array.from({ length: 301 }, (_, i) => i),
      {
        maxHr: 100,
        restingHr: -150,
        heartRate: () => 0,
      },
    );
    expect(rows).toMatchObject([{ avg_hr_z2: 0, efficiency_factor: 0 }]);
  });

  it.each([
    { startDate: "2026-02-10", endDateExclusive: "2026-02-11", isDeleted: 0 },
    { startDate: "2026-02-11", endDateExclusive: "2026-02-12", isDeleted: 1 },
    { startDate: "2026-02-09", endDateExclusive: "2026-02-10", isDeleted: 1 },
  ])(
    "enforces access bounds $startDate to $endDateExclusive",
    async ({ startDate, endDateExclusive, isDeleted }) => {
      const rows = await compute(
        Array.from({ length: 61 }, (_, i) => i * 5),
        {
          accessWindow: {
            kind: "limited",
            paid: false,
            reason: "free_recent_week",
            startDate,
            endDateExclusive,
          },
        },
      );
      expect(rows[0]?.is_deleted).toBe(isDeleted);
    },
  );
});
