import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { routeComparisonsSchema } from "@dofek/training/route-comparison";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { HikingRepository } from "./hiking-repository.ts";

describe("GPS route comparison serving queries", () => {
  const database = `hiking_comparison_${randomUUID().replaceAll("-", "")}`;
  const userId = randomUUID();
  let client: ReturnType<typeof createClient>;
  const store = {
    async query<TSchema extends z.ZodType>(
      schema: TSchema,
      query: string,
      params?: Record<string, unknown>,
    ): Promise<z.infer<TSchema>[]> {
      const result = await client.query({
        query: query.replaceAll("analytics.", `${database}.`),
        query_params: params,
        format: "JSONEachRow",
      });
      return z.array(schema).parse(await result.json());
    },
  };
  const repository = () =>
    new HikingRepository({ execute: async () => [] }, userId, "America/Los_Angeles", store);

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL?.trim();
    if (!url) throw new Error("CLICKHOUSE_URL is required for GPS route comparison tests");
    client = createClient({ url });
    await client.command({ query: `CREATE DATABASE ${database}` });
    const tables = [
      [
        "hiking_activity",
        "activity_id UUID, user_id UUID, canonical_type String, activity_name Nullable(String), started_at DateTime64(6, 'UTC'), distance_m Float64, duration_seconds Float64, average_pace_min_per_km Float64, avg_heart_rate Nullable(Float64), elevation_gain_m Float64",
        "user_id, activity_id",
      ],
      [
        "deduped_activities",
        "activity_id UUID, user_id UUID, modality Nullable(String)",
        "user_id, activity_id",
      ],
      [
        "activity_route_identity",
        "canonical_activity_id UUID, user_id UUID, points Array(Tuple(lat Float64, lng Float64)), route_distance_meters Nullable(Float64), elevation_profile Array(Float64), coverage_pct Nullable(Float64), largest_gap_seconds Nullable(Float64), geometry_status String",
        "user_id, canonical_activity_id",
      ],
    ];
    for (const [table, columns, order] of tables) {
      await client.command({
        query: `CREATE TABLE ${database}.${table} (${columns}, refresh_version UInt64, is_deleted UInt8) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (${order})`,
      });
    }
  });

  beforeEach(async () => {
    for (const table of ["hiking_activity", "deduped_activities", "activity_route_identity"]) {
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
    }
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  async function seed(
    options: {
      name?: string | null;
      owner?: string;
      offset?: number;
      type?: string;
      distance?: number;
      pace?: number;
      daysAgo?: number;
      hour?: number;
      deletedTable?: "hiking_activity" | "deduped_activities" | "activity_route_identity";
      geometryStatus?: string;
    } = {},
  ) {
    const id = randomUUID();
    const started = new Date();
    started.setUTCDate(started.getUTCDate() - (options.daysAgo ?? 2));
    started.setUTCHours(options.hour ?? 8, 0, 0, 0);
    const owner = options.owner ?? userId;
    const offset = options.offset ?? 0;
    const hiking = {
      activity_id: id,
      user_id: owner,
      canonical_type: options.type ?? "hiking",
      activity_name: options.name === undefined ? "Trail Loop" : options.name,
      started_at: started.toISOString().replace("T", " ").replace("Z", ""),
      distance_m: options.distance ?? 5000,
      duration_seconds: 3600,
      average_pace_min_per_km: options.pace ?? 12,
      avg_heart_rate: null,
      elevation_gain_m: 200,
      refresh_version: 1,
      is_deleted: 0,
    };
    const activity = {
      activity_id: id,
      user_id: owner,
      modality: null,
      refresh_version: 1,
      is_deleted: 0,
    };
    const route = {
      canonical_activity_id: id,
      user_id: owner,
      points: [37.77, 37.785, 37.8, 37.815].map((lat) => ({ lat: lat + offset, lng: -122.42 })),
      route_distance_meters: 5000,
      elevation_profile: [],
      coverage_pct: 100,
      largest_gap_seconds: 10,
      geometry_status: options.geometryStatus ?? "available",
      refresh_version: 1,
      is_deleted: 0,
    };
    for (const [table, row] of [
      ["hiking_activity", hiking],
      ["deduped_activities", activity],
      ["activity_route_identity", route],
    ] as const) {
      await client.insert({
        table: `${database}.${table}`,
        values: [
          row,
          ...(options.deletedTable === table
            ? [{ ...row, refresh_version: 2, is_deleted: 1 }]
            : []),
        ],
        format: "JSONEachRow",
      });
    }
    return { id, startedAt: started.toISOString() };
  }

  it("groups actual GPS routes across titles, retains same-day identities, and marks missing pace unavailable", async () => {
    const first = await seed({ distance: 0, pace: 0, hour: 8 });
    const second = await seed({ name: "Afternoon Walk", hour: 16 });
    await seed({ offset: 1 }); // Same title, unrelated route.
    await seed({ type: "walking" }); // Same geometry, different activity context.
    const result = routeComparisonsSchema.parse(await repository().getRepeatedRoutes(30));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ attemptCount: 2, activityType: "hiking" });
    expect(result[0]?.instances).toMatchObject([
      {
        activityId: first.id,
        startedAt: first.startedAt,
        averagePaceMinPerKm: null,
        distanceKm: null,
      },
      {
        activityId: second.id,
        activityName: "Afternoon Walk",
        startedAt: second.startedAt,
        averagePaceMinPerKm: 12,
        distanceKm: 5,
      },
    ]);
    expect(result[0]?.instances[0]?.date).toBe(result[0]?.instances[1]?.date);
  });

  it("filters ownership, selected dates, deletion versions and incomplete geometry before grouping", async () => {
    const first = await seed();
    const second = await seed({ name: null });
    await seed({ owner: randomUUID() });
    await seed({ daysAgo: 400 });
    await seed({ deletedTable: "hiking_activity" });
    await seed({ deletedTable: "deduped_activities" });
    await seed({ deletedTable: "activity_route_identity" });
    await seed({ geometryStatus: "partial" });
    const result = await repository().getRepeatedRoutes(30);
    expect(result).toHaveLength(1);
    expect(new Set(result[0]?.instances.map((instance) => instance.activityId))).toEqual(
      new Set([first.id, second.id]),
    );
    const allTime = await repository().getRepeatedRoutes(null);
    expect(allTime[0]?.attemptCount).toBe(3);
  });
});

describe("HikingRepository", () => {
  const database = `hiking_${randomUUID().replaceAll("-", "")}`;
  const userId = randomUUID();
  const clickhouse = createClient({ url: process.env.CLICKHOUSE_URL });
  const namedHikeId = randomUUID();
  const unnamedHikeId = randomUUID();
  const unnamedWalkId = randomUUID();
  const unnamedRunId = randomUUID();
  let store: ClickHouseActivitySensorStore;

  beforeAll(async () => {
    await clickhouse.command({ query: `CREATE DATABASE ${database}` });
    await clickhouse.command({
      query: `CREATE TABLE ${database}.hiking_activity (
        activity_id UUID,
        user_id UUID,
        canonical_type String,
        activity_name Nullable(String),
        started_at DateTime64(6, 'UTC'),
        distance_m Nullable(Float64),
        duration_seconds Float64,
        elevation_gain_m Nullable(Float64),
        elevation_loss_m Nullable(Float64),
        average_grade_percent Nullable(Float64),
        is_deleted UInt8,
        refresh_version UInt64 DEFAULT 1
      ) ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    });
    await clickhouse.insert({
      table: `${database}.hiking_activity`,
      format: "JSONEachRow",
      values: [
        {
          activity_id: namedHikeId,
          canonical_type: "hiking",
          activity_name: "Morning Hike",
          started_at: "2026-10-19 09:00:00",
        },
        {
          activity_id: unnamedHikeId,
          canonical_type: "hiking",
          activity_name: null,
          started_at: "2026-10-20 09:00:00",
        },
        {
          activity_id: unnamedWalkId,
          canonical_type: "walking",
          activity_name: null,
          started_at: "2026-10-21 09:00:00",
        },
        {
          activity_id: unnamedRunId,
          canonical_type: "running",
          activity_name: null,
          started_at: "2026-10-22 09:00:00",
        },
      ].map((activity) => ({
        ...activity,
        user_id: userId,
        distance_m: 5000,
        duration_seconds: 3600,
        elevation_gain_m: 100,
        elevation_loss_m: 100,
        average_grade_percent: 0,
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

  it("retains unnamed hiking, walking, and running activities with type labels and pace metrics", async () => {
    const repository = new HikingRepository({ execute: async () => [] }, userId, "UTC", store);
    const details = (await repository.getGradeAdjustedPaces(null)).map((activity) =>
      activity.toDetail(),
    );

    expect(
      details.map(({ activityId, activityName, activityType }) => ({
        activityId,
        activityName,
        activityType,
      })),
    ).toEqual([
      { activityId: namedHikeId, activityName: "Morning Hike", activityType: "hiking" },
      { activityId: unnamedHikeId, activityName: "Hiking", activityType: "hiking" },
      { activityId: unnamedWalkId, activityName: "Walking", activityType: "walking" },
      { activityId: unnamedRunId, activityName: "Running", activityType: "running" },
    ]);
    for (const detail of details) {
      expect(detail).toMatchObject({
        distanceKm: 5,
        durationMinutes: 60,
        averagePaceMinPerKm: 12,
        gradeAdjustedPaceMinPerKm: 12,
        elevationGainMeters: 100,
        elevationLossMeters: 100,
      });
    }
  });
});
