import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { CyclingPowerProfileRepository } from "./cycling-power-profile-repository.ts";

describe("Cycling power profile database semantics", () => {
  const database = `cycling_profile_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const stravaDirect = randomUUID();
  const stravaEstimate = randomUUID();
  const stravaUntagged = randomUUID();
  const unknownRide = randomUUID();
  const outsideRide = randomUUID();
  const deletedRide = randomUUID();
  const otherRide = randomUUID();
  const nearbyWeightId = randomUUID();
  const laterWeightId = randomUUID();
  const range = { startDate: "2026-10-30", endDate: "2026-10-31" };
  let postgres: TestContext;
  const store: Pick<ActivitySensorStore, "query"> = {
    async query<TSchema extends z.ZodType>(schema: TSchema, query: string, params = {}) {
      const result = await client.query({
        query: query.replaceAll("analytics.", `${database}.`),
        query_params: params,
        format: "JSONEachRow",
      });
      return z.array(schema).parse(await result.json());
    },
  };

  beforeAll(async () => {
    postgres = await setupTestDatabase();
    await postgres.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name) VALUES (${userId}::uuid, 'Profile fixture')
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.sport_settings (user_id, sport, ftp, effective_from) VALUES
        (${userId}::uuid, 'cycling', 280, '2026-10-12'),
        (${userId}::uuid, 'cycling', 288, '2026-10-25'),
        (${userId}::uuid, 'cycling', NULL, '2026-11-01')
    `);
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `
      CREATE TABLE ${database}.deduped_activities (
        activity_id UUID, user_id UUID, started_at DateTime64(6, 'UTC'),
        ended_at Nullable(DateTime64(6, 'UTC')), canonical_type String, modality Nullable(String),
        name Nullable(String), member_activity_ids Array(UUID), refresh_version UInt64, is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    });
    await client.command({
      query: `
      CREATE TABLE ${database}.activity_power_curve (
        activity_id UUID, user_id UUID, started_at DateTime64(6, 'UTC'), duration_seconds UInt32,
        best_power Int32, start_offset_seconds Nullable(Float64), observed_samples Nullable(UInt64),
        median_sample_interval_seconds Nullable(Float64), largest_gap_seconds Nullable(Float64),
        coverage_pct Nullable(Float64), power_measurement_kind Nullable(String),
        source_providers Array(String), source_devices Array(String), refresh_version UInt64, is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id, duration_seconds)`,
    });
    await client.command({
      query: `
      CREATE TABLE ${database}.activity_source_records (
        activity_id UUID, user_id UUID, provider_id String, raw Nullable(String),
        refresh_version UInt64, is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    });
    await client.command({
      query: `
      CREATE TABLE ${database}.v_body_measurement (
        id UUID, user_id UUID, recorded_at DateTime64(6, 'UTC'), weight_kg Nullable(Float64),
        provider_id String, external_id Nullable(String)
      ) ENGINE = MergeTree ORDER BY (user_id, recorded_at)`,
    });

    const startedAt = "2026-10-31 06:30:00";
    const lastDay = "2026-11-01 06:30:00";
    const dates = [
      [stravaDirect, startedAt],
      [stravaEstimate, startedAt],
      [stravaUntagged, lastDay],
      [unknownRide, lastDay],
      [outsideRide, "2026-11-01 08:00:00"],
      [deletedRide, lastDay],
      [otherRide, lastDay],
    ];
    const rides = dates.map(([id, start]) => ({
      activity_id: id,
      user_id: id === otherRide ? otherUserId : userId,
      started_at: start,
      ended_at: "2026-11-01 09:00:00",
      canonical_type: "cycling",
      modality: "road",
      name: "Fixture ride",
      member_activity_ids: [id],
      refresh_version: 1,
      is_deleted: 0,
    }));
    const deleted = rides.find((ride) => ride.activity_id === deletedRide);
    await client.insert({
      table: `${database}.deduped_activities`,
      values: [...rides, { ...deleted, is_deleted: 1, refresh_version: 2 }],
      format: "JSONEachRow",
    });
    await client.insert({
      table: `${database}.activity_source_records`,
      values: [
        { activity_id: stravaDirect, raw: '{"device_watts":true}' },
        { activity_id: stravaEstimate, raw: '{"device_watts":false}' },
        { activity_id: stravaUntagged, raw: "{}" },
      ].map((claim) => ({
        ...claim,
        user_id: userId,
        provider_id: "strava",
        refresh_version: 1,
        is_deleted: 0,
      })),
      format: "JSONEachRow",
    });
    const efforts = [
      { id: stravaEstimate, seconds: 5, watts: 1200, kind: "unknown", provider: "strava" },
      { id: stravaDirect, seconds: 5, watts: 700, kind: "unknown", provider: "strava" },
      { id: unknownRide, seconds: 5, watts: 1000, kind: "unknown", provider: "fit-file" },
      { id: stravaUntagged, seconds: 60, watts: 0, kind: "unknown", provider: "strava" },
      { id: unknownRide, seconds: 300, watts: 336, kind: "direct", provider: "fit-file" },
      { id: outsideRide, seconds: 300, watts: 1100, kind: "direct", provider: "fit-file" },
      { id: deletedRide, seconds: 300, watts: 1100, kind: "direct", provider: "fit-file" },
      { id: otherRide, seconds: 300, watts: 1100, kind: "direct", provider: "fit-file" },
    ];
    await client.insert({
      table: `${database}.activity_power_curve`,
      values: efforts.map(({ id, seconds, watts, kind, provider }) => ({
        activity_id: id,
        user_id: id === otherRide ? otherUserId : userId,
        started_at: dates.find(([activityId]) => activityId === id)?.[1],
        duration_seconds: seconds,
        best_power: watts,
        power_measurement_kind: kind,
        start_offset_seconds: 100,
        observed_samples: seconds + 1,
        median_sample_interval_seconds: 1,
        largest_gap_seconds: 1,
        coverage_pct: 100,
        source_providers: [provider],
        source_devices: [],
        refresh_version: 1,
        is_deleted: 0,
      })),
      format: "JSONEachRow",
    });
    await client.insert({
      table: `${database}.v_body_measurement`,
      values: [
        { id: nearbyWeightId, recorded_at: "2026-10-30 18:00:00" },
        { id: laterWeightId, recorded_at: "2026-11-02 18:00:00" },
      ].map((weight) => ({
        ...weight,
        user_id: userId,
        weight_kg: 72,
        provider_id: "withings",
        external_id: null,
      })),
      format: "JSONEachRow",
    });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
    await postgres?.cleanup();
  });

  it("ranks eligible efforts inside the inclusive local dates, including observed zero", async () => {
    const result = await new CyclingPowerProfileRepository(
      postgres.db,
      store,
      userId,
      "America/Los_Angeles",
    ).read(range);

    expect(
      result.efforts.map(({ effort }) => [effort?.activity_id, effort?.watts, effort?.power_kind]),
    ).toEqual([
      [stravaDirect, 700, "direct"],
      [stravaUntagged, 0, "unknown"],
      [unknownRide, 336, "direct"],
    ]);
    expect(result.threshold).toMatchObject({
      watts: 288,
      effective_from: "2026-10-25",
      weight: {
        kind: "interpolated",
        sources: [{ record_id: nearbyWeightId }, { record_id: laterWeightId }],
      },
    });
  });

  it("applies entitlement bounds to both activities and weight observations", async () => {
    const result = await new CyclingPowerProfileRepository(
      postgres.db,
      store,
      userId,
      "America/Los_Angeles",
      {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-10-31",
        endDateExclusive: "2026-11-01",
      },
    ).read(range);
    expect(result.efforts[0]?.effort).toMatchObject({
      activity_id: unknownRide,
      watts: 1000,
      watts_per_kg: null,
    });
    expect(result.threshold).toMatchObject({ watts: 288, watts_per_kg: null });
  });

  it("uses a clear effective on the selected end date", async () => {
    const result = await new CyclingPowerProfileRepository(
      postgres.db,
      store,
      userId,
      "America/Los_Angeles",
    ).read({ startDate: null, endDate: "2026-11-01" });
    expect(result.threshold).toMatchObject({ watts: null, effective_from: "2026-11-01" });
  });
});
