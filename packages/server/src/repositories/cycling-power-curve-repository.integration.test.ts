import { randomUUID } from "node:crypto";
import { referenceBestPower } from "@dofek/training/power-duration-reference";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { CyclingPowerCurveRepository } from "./cycling-power-curve-repository.ts";

const userId = "00000000-0000-0000-0000-000000000001";
const canonicalWahooActivityId = randomUUID();
const stravaMemberActivityId = randomUUID();
const pelotonActivityId = randomUUID();
const wahooStartedAt = "2026-06-15 15:00:00.000000";
const pelotonStartedAt = "2026-06-20 15:00:00.000000";

describe("CyclingPowerCurveRepository", () => {
  const database = `cycling_power_curve_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();
  const store: Pick<ActivitySensorStore, "query"> = {
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

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.deduped_activities (
        activity_id UUID,
        user_id UUID,
        started_at DateTime64(6, 'UTC'),
        canonical_type String,
        modality Nullable(String),
        source_providers Array(String),
        member_activity_ids Array(UUID),
        refresh_version UInt64,
        is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.activity_power_curve (
        activity_id UUID,
        user_id UUID,
        started_at DateTime64(6, 'UTC'),
        duration_seconds UInt32,
        best_power Int32,
        start_offset_seconds Nullable(Float64),
        observed_samples Nullable(UInt64),
        median_sample_interval_seconds Nullable(Float64),
        largest_gap_seconds Nullable(Float64),
        coverage_pct Nullable(Float64),
        power_measurement_kind Nullable(String),
        source_providers Array(String),
        source_devices Array(String),
        refresh_version UInt64,
        is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, duration_seconds)`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.activity_sensor_sample (
        activity_id UUID,
        user_id UUID,
        recorded_at DateTime64(6, 'UTC'),
        channel LowCardinality(String),
        scalar Nullable(Float64),
        provider_id Nullable(String),
        device_id Nullable(String),
        measurement_kind LowCardinality(String),
        refresh_version UInt64,
        is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, channel, recorded_at)`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.v_body_measurement (
        user_id UUID,
        recorded_at DateTime64(6, 'UTC'),
        weight_kg Nullable(Float64),
        provider_id String,
        external_id Nullable(String)
      ) ENGINE = MergeTree
      ORDER BY (user_id, recorded_at)`,
    });

    await client.insert({
      table: `${database}.deduped_activities`,
      values: [
        {
          activity_id: canonicalWahooActivityId,
          user_id: userId,
          started_at: wahooStartedAt,
          canonical_type: "cycling",
          modality: "outdoor",
          source_providers: ["wahoo", "strava"],
          member_activity_ids: [canonicalWahooActivityId, stravaMemberActivityId],
          refresh_version: 1,
          is_deleted: 0,
        },
        {
          activity_id: pelotonActivityId,
          user_id: userId,
          started_at: pelotonStartedAt,
          canonical_type: "cycling",
          modality: "virtual",
          source_providers: ["peloton"],
          member_activity_ids: [pelotonActivityId],
          refresh_version: 1,
          is_deleted: 0,
        },
      ],
      format: "JSONEachRow",
    });

    const wahooStartMs = Date.parse("2026-06-15T15:00:00.000Z");
    const wahooSamples = Array.from({ length: 601 }, (_, offsetSeconds) => ({
      activity_id: canonicalWahooActivityId,
      user_id: userId,
      recorded_at: new Date(wahooStartMs + offsetSeconds * 1000)
        .toISOString()
        .replace("T", " ")
        .replace("Z", ""),
      channel: "power",
      scalar: 250,
      provider_id: "wahoo",
      device_id: "elemnt-bolt",
      measurement_kind: "direct",
      refresh_version: 2,
      is_deleted: 0,
    }));
    const duplicateStravaSamples = wahooSamples.map((sample) => ({
      ...sample,
      provider_id: "strava",
      device_id: "strava-import",
      refresh_version: 1,
    }));
    const pelotonStartMs = Date.parse("2026-06-20T15:00:00.000Z");
    const pelotonSamples = Array.from({ length: 121 }, (_, index) => ({
      activity_id: pelotonActivityId,
      user_id: userId,
      recorded_at: new Date(pelotonStartMs + index * 5000)
        .toISOString()
        .replace("T", " ")
        .replace("Z", ""),
      channel: "power",
      scalar: 200,
      provider_id: "peloton",
      device_id: "peloton-bike",
      measurement_kind: "direct",
      refresh_version: 1,
      is_deleted: 0,
    }));
    await client.insert({
      table: `${database}.activity_sensor_sample`,
      values: [...duplicateStravaSamples, ...wahooSamples, ...pelotonSamples],
      format: "JSONEachRow",
    });

    await client.insert({
      table: `${database}.activity_power_curve`,
      values: [300, 1200, 1800, 3600].map((durationSeconds, index) => ({
        activity_id: canonicalWahooActivityId,
        user_id: userId,
        started_at: wahooStartedAt,
        duration_seconds: durationSeconds,
        best_power: [320, 300, 280, 250][index],
        start_offset_seconds: durationSeconds === 1200 ? 420 : 0,
        observed_samples: durationSeconds + 1,
        median_sample_interval_seconds: 1,
        largest_gap_seconds: 1,
        coverage_pct: 100,
        power_measurement_kind: "direct",
        source_providers: ["wahoo"],
        source_devices: ["elemnt-bolt"],
        refresh_version: 1,
        is_deleted: 0,
      })),
      format: "JSONEachRow",
    });
    await client.insert({
      table: `${database}.v_body_measurement`,
      values: [
        {
          user_id: userId,
          recorded_at: "2026-06-15 14:00:00.000000",
          weight_kg: 70,
          provider_id: "withings",
          external_id: "weight-2026-06-15",
        },
      ],
      format: "JSONEachRow",
    });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("queries standard and custom durations without duplicate activity inflation", async () => {
    const repository = new CyclingPowerCurveRepository(store, userId, "UTC");
    const result = await repository.listRange({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      durationsSeconds: [300, 421, 1200, 1800, 3600],
      modalities: ["outdoor"],
      providers: [],
      includeActivityCurve: true,
      cursor: null,
      limit: 20,
    });

    expect(result.bests.map((effort) => effort.duration_seconds)).toEqual([
      300, 421, 1200, 1800, 3600,
    ]);
    const reference = referenceBestPower(
      Array.from({ length: 601 }, (_, elapsedSeconds) => ({ elapsedSeconds, watts: 250 })),
      421,
    );
    expect(result.bests.find((effort) => effort.duration_seconds === 421)).toMatchObject({
      activity_id: canonicalWahooActivityId,
      source_providers: ["wahoo"],
      member_activity_ids: [canonicalWahooActivityId, stravaMemberActivityId],
      watts: reference?.watts,
      watts_per_kg: 3.571,
    });
    expect(
      result.activity_curve.filter(
        (effort) =>
          effort.duration_seconds === 421 && effort.activity_id === canonicalWahooActivityId,
      ),
    ).toHaveLength(1);
  });

  it("honors provider filters and source resolution limits", async () => {
    const repository = new CyclingPowerCurveRepository(store, userId, "UTC");
    const result = await repository.listRange({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      durationsSeconds: [1, 421],
      modalities: ["virtual"],
      providers: ["peloton"],
      includeActivityCurve: false,
      cursor: null,
      limit: 20,
    });

    expect(result.bests.find((effort) => effort.duration_seconds === 1)).toBeUndefined();
    expect(result.bests.find((effort) => effort.duration_seconds === 421)).toMatchObject({
      activity_id: pelotonActivityId,
      source_providers: ["peloton"],
      watts: 200,
    });
  });
});
