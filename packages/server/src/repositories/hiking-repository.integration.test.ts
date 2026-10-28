import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { HikingRepository } from "./hiking-repository.ts";

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
