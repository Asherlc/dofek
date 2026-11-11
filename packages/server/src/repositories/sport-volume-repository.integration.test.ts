import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { SportVolumeRepository } from "./sport-volume-repository.ts";

const fullAccess = { kind: "full", paid: true, reason: "paid_grant" } as const;

describe("SportVolumeRepository", () => {
  const database = `sport_volume_${randomUUID().replaceAll("-", "")}`;
  const userId = randomUUID();
  const clickhouse = createClient({ url: process.env.CLICKHOUSE_URL });
  let store: ClickHouseActivitySensorStore;
  const runningId = randomUUID();
  const cyclingId = randomUUID();

  beforeAll(async () => {
    await clickhouse.command({ query: `CREATE DATABASE ${database}` });
    for (const [name, columns, key] of [
      [
        "deduped_activities",
        "activity_id UUID, user_id UUID, canonical_type String, modality Nullable(String), started_at DateTime64(6,'UTC'), ended_at Nullable(DateTime64(6,'UTC')), is_deleted UInt8",
        "user_id, activity_id",
      ],
      [
        "activity_summary",
        "activity_id UUID, user_id UUID, total_distance Nullable(Float64), elevation_gain_m Nullable(Float64)",
        "user_id, activity_id",
      ],
      [
        "activity_sensor_sample",
        "activity_id UUID, user_id UUID, channel String, recorded_at DateTime64(6,'UTC'), scalar Nullable(Float64), is_deleted UInt8",
        "user_id, activity_id, channel, recorded_at",
      ],
    ]) {
      await clickhouse.command({
        query: `CREATE TABLE ${database}.${name} (${columns}, refresh_version UInt64 DEFAULT 1) ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (${key})`,
      });
    }
    const activities = [
      {
        activity_id: runningId,
        canonical_type: "running",
        modality: "outdoor",
        ended_at: "2026-10-19 01:30:00",
      },
      {
        activity_id: randomUUID(),
        canonical_type: "running",
        modality: "outdoor",
        ended_at: "2026-10-19 01:00:00",
      },
      {
        activity_id: cyclingId,
        canonical_type: "cycling",
        modality: "indoor",
        ended_at: "2026-10-19 00:30:03",
      },
      {
        activity_id: randomUUID(),
        canonical_type: "swimming",
        modality: null,
        ended_at: "2026-10-19 01:00:00",
      },
      {
        activity_id: randomUUID(),
        canonical_type: "yoga",
        modality: null,
        ended_at: "2026-10-19 01:00:00",
      },
    ];
    await clickhouse.insert({
      table: `${database}.deduped_activities`,
      format: "JSONEachRow",
      values: activities.map((activity) => ({
        ...activity,
        user_id: userId,
        started_at: "2026-10-19 00:30:00",
        is_deleted: 0,
      })),
    });
    await clickhouse.insert({
      table: `${database}.deduped_activities`,
      format: "JSONEachRow",
      values: [
        {
          activity_id: randomUUID(),
          user_id: randomUUID(),
          canonical_type: "running",
          modality: null,
          started_at: "2026-10-19 00:30:00",
          ended_at: "2026-10-19 01:30:00",
          is_deleted: 0,
        },
        {
          activity_id: randomUUID(),
          user_id: userId,
          canonical_type: "running",
          modality: null,
          started_at: "2026-10-19 00:30:00",
          ended_at: "2026-10-19 01:30:00",
          is_deleted: 1,
        },
      ],
    });
    await clickhouse.insert({
      table: `${database}.activity_summary`,
      format: "JSONEachRow",
      values: [
        { activity_id: runningId, user_id: userId, total_distance: 10000, elevation_gain_m: 100 },
        { activity_id: cyclingId, user_id: userId, total_distance: 50000, elevation_gain_m: 1000 },
      ],
    });
    await clickhouse.insert({
      table: `${database}.activity_sensor_sample`,
      format: "JSONEachRow",
      values: [0, 1, 2].map((second) => ({
        activity_id: cyclingId,
        user_id: userId,
        channel: "power",
        recorded_at: `2026-10-19 00:30:0${second}`,
        scalar: 200,
        is_deleted: 0,
      })),
    });
    store = new ClickHouseActivitySensorStore({
      command: (options) => clickhouse.command(options),
      async query<TRow extends object>(options: {
        query: string;
        format: "JSONEachRow";
        query_params: Record<string, unknown>;
        abort_signal?: AbortSignal;
      }) {
        const result = await clickhouse.query({
          ...options,
          query: options.query.replaceAll("analytics.", `${database}.`),
        });
        return { json: () => result.json<TRow>() };
      },
    });
  });
  afterAll(async () => {
    await clickhouse.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await clickhouse.close();
  });

  it("aggregates each sport by the caller's local week and isolates owned active records", async () => {
    const result = await new SportVolumeRepository(
      store,
      userId,
      "America/Los_Angeles",
      fullAccess,
    ).getVolume({ days: null, sport: "running", metric: "time" });
    expect(result.weeks).toEqual([{ week: "2026-10-12", value: 90 }]);
    expect(result.sports).toEqual(["cycling", "running", "swimming", "yoga"]);
  });
  it("leaves a weekly distance total unknown if an activity lacks distance", async () => {
    const result = await new SportVolumeRepository(store, userId, "UTC", fullAccess).getVolume({
      days: null,
      sport: "running",
      metric: "distance",
    });
    expect(result.weeks).toEqual([{ week: "2026-10-19", value: null }]);
  });
  it("excludes indoor cycling distance while computing mechanical work from recorded power", async () => {
    const repository = new SportVolumeRepository(store, userId, "UTC", fullAccess);
    expect(
      (await repository.getVolume({ days: null, sport: "cycling", metric: "distance" })).weeks,
    ).toEqual([{ week: "2026-10-19", value: null }]);
    expect(
      (await repository.getVolume({ days: null, sport: "cycling", metric: "work" })).weeks,
    ).toEqual([{ week: "2026-10-19", value: 0.6 }]);
  });
  it("offers time for other sports and distance for swimming", async () => {
    const repository = new SportVolumeRepository(store, userId, "UTC", fullAccess);
    expect(
      (await repository.getVolume({ days: null, sport: "yoga", metric: "time" })).metrics.map(
        (metric) => metric.key,
      ),
    ).toEqual(["time"]);
    expect(
      (await repository.getVolume({ days: null, sport: "swimming", metric: "time" })).metrics.map(
        (metric) => metric.key,
      ),
    ).toEqual(["time", "distance"]);
  });
  it("enforces access limits and finite selected ranges", async () => {
    const repository = new SportVolumeRepository(store, userId, "UTC", {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2000-01-01",
      endDateExclusive: "2000-02-01",
    });
    expect(
      (await repository.getVolume({ days: null, sport: "running", metric: "time" })).weeks,
    ).toEqual([]);
    expect(
      (
        await new SportVolumeRepository(store, userId, "UTC", fullAccess).getVolume({
          days: 1,
          sport: "running",
          metric: "time",
        })
      ).weeks,
    ).toEqual([]);
  });
  it("starts a one-day range at caller-local midnight", async () => {
    const boundaryUser = randomUUID();
    for (const offset of [-1, 1]) {
      await clickhouse.command({
        query: `INSERT INTO ${database}.deduped_activities (activity_id,user_id,canonical_type,modality,started_at,ended_at,is_deleted)
        SELECT generateUUIDv4(), {userId:UUID}, 'walking', NULL,
          toDateTime64(toDate(now(), 'America/Los_Angeles'),6,'America/Los_Angeles') + toIntervalMinute({offset:Int32}),
          toDateTime64(toDate(now(), 'America/Los_Angeles'),6,'America/Los_Angeles') + toIntervalMinute({offset:Int32}) + INTERVAL 1 MINUTE, 0`,
        query_params: { userId: boundaryUser, offset },
      });
    }
    const result = await new SportVolumeRepository(
      store,
      boundaryUser,
      "America/Los_Angeles",
      fullAccess,
    ).getVolume({ days: 1, sport: "walking", metric: "time" });
    expect(result.weeks).toHaveLength(1);
    expect(result.weeks[0]?.value).toBe(1);
  });
  it("does not treat the indoor distance sentinel as a measured zero", async () => {
    const indoorUser = randomUUID();
    const indoorId = randomUUID();
    await clickhouse.insert({
      table: `${database}.deduped_activities`,
      format: "JSONEachRow",
      values: [
        {
          activity_id: indoorId,
          user_id: indoorUser,
          canonical_type: "running",
          modality: "indoor",
          started_at: "2026-10-19 00:30:00",
          ended_at: "2026-10-19 01:30:00",
          is_deleted: 0,
        },
      ],
    });
    await clickhouse.insert({
      table: `${database}.activity_summary`,
      format: "JSONEachRow",
      values: [
        { activity_id: indoorId, user_id: indoorUser, total_distance: 0, elevation_gain_m: null },
      ],
    });
    const result = await new SportVolumeRepository(store, indoorUser, "UTC", fullAccess).getVolume({
      days: null,
      sport: "running",
      metric: "distance",
    });
    expect(result.weeks).toEqual([{ week: "2026-10-19", value: null }]);
  });
});
