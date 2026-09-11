import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { cyclingEffortMetricsSchema } from "../mcp/performance-comparison-output.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { loadCyclingEffortMetrics } from "./cycling-effort-metrics.ts";
import { CyclingTrainingMetricsRepository } from "./cycling-training-metrics-repository.ts";

const activityId = randomUUID();
const duplicateMemberId = randomUUID();

describe("CyclingTrainingMetricsRepository database semantics", () => {
  const analyticsDatabase = `cycling_training_metrics_${randomUUID().replaceAll("-", "")}`;
  const clickhouse = createClickHouseClientFromEnv();
  let postgres: TestContext;
  const store: Pick<ActivitySensorStore, "query"> = {
    async query<TSchema extends z.ZodType>(
      schema: TSchema,
      query: string,
      params?: Record<string, unknown>,
    ): Promise<z.infer<TSchema>[]> {
      const result = await clickhouse.query({
        query: query.replaceAll("analytics.", `${analyticsDatabase}.`),
        query_params: params,
        format: "JSONEachRow",
      });
      return z.array(schema).parse(await result.json());
    },
  };

  beforeAll(async () => {
    postgres = await setupTestDatabase();
    await postgres.db.execute(sql`
      DELETE FROM fitness.sport_settings
      WHERE user_id = ${TEST_USER_ID} AND sport = 'cycling'
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.sport_settings (
        user_id, sport, ftp, threshold_hr, power_zone_pcts, hr_zone_pcts, effective_from
      ) VALUES (
        ${TEST_USER_ID}, 'cycling', 250, 175,
        '[0.55,0.75,0.9,1.05,1.2,1.5]'::jsonb,
        '[0.6,0.7,0.8,0.9]'::jsonb,
        '2026-01-01'
      )
    `);

    await clickhouse.command({ query: `CREATE DATABASE ${analyticsDatabase}` });
    await clickhouse.command({
      query: `CREATE TABLE ${analyticsDatabase}.activity_summary_rows (
      activity_id UUID, user_id UUID, total_distance Nullable(Float64),
      refresh_version UInt64, is_deleted UInt8
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    });
    await clickhouse.command({
      query: `CREATE TABLE ${analyticsDatabase}.v_body_measurement (
      user_id UUID, recorded_at DateTime64(6, 'UTC'), weight_kg Nullable(Float64),
      provider_id String, external_id Nullable(String)
    ) ENGINE = MergeTree ORDER BY (user_id, recorded_at)`,
    });
    await clickhouse.command({
      query: `CREATE TABLE ${analyticsDatabase}.cycling_activity (
        activity_id UUID,
        user_id UUID,
        provider_id String,
        modality Nullable(String),
        activity_name Nullable(String),
        started_at DateTime64(6, 'UTC'),
        ended_at Nullable(DateTime64(6, 'UTC')),
        elapsed_seconds UInt32,
        average_power Nullable(Float64),
        normalized_power Nullable(Float64),
        average_heart_rate Nullable(Float64),
        max_heart_rate Nullable(Float64),
        refresh_version UInt64,
        is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id)`,
    });
    await clickhouse.command({
      query: `CREATE TABLE ${analyticsDatabase}.deduped_activities (
        activity_id UUID,
        user_id UUID,
        started_at DateTime64(6, 'UTC'),
        source_providers Array(String),
        member_activity_ids Array(UUID),
        timezone Nullable(String),
        local_time_source String,
        refresh_version UInt64,
        is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id)`,
    });
    await clickhouse.command({
      query: `CREATE TABLE ${analyticsDatabase}.activity_sensor_sample (
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
    await clickhouse.command({
      query: `CREATE TABLE ${analyticsDatabase}.activity_power_curve (
        activity_id UUID,
        user_id UUID,
        duration_seconds UInt32,
        best_power Float64,
        start_offset_seconds Nullable(Float64),
        observed_samples Nullable(UInt64),
        coverage_pct Nullable(Float64),
        largest_gap_seconds Nullable(Float64),
        median_sample_interval_seconds Nullable(Float64),
        power_measurement_kind Nullable(String),
        refresh_version UInt64,
        is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, duration_seconds)`,
    });

    await clickhouse.insert({
      table: `${analyticsDatabase}.cycling_activity`,
      values: [
        {
          activity_id: activityId,
          user_id: TEST_USER_ID,
          provider_id: "wahoo",
          modality: "outdoor",
          activity_name: "Duplicate-source ride",
          started_at: "2026-06-15 15:00:00.000000",
          ended_at: "2026-06-15 15:10:00.000000",
          elapsed_seconds: 600,
          average_power: 150,
          normalized_power: 150,
          average_heart_rate: 130,
          max_heart_rate: 130,
          refresh_version: 1,
          is_deleted: 0,
        },
      ],
      format: "JSONEachRow",
    });
    await clickhouse.insert({
      table: `${analyticsDatabase}.deduped_activities`,
      values: [
        {
          activity_id: activityId,
          user_id: TEST_USER_ID,
          started_at: "2026-06-15 15:00:00.000000",
          source_providers: ["strava", "wahoo"],
          member_activity_ids: [activityId, duplicateMemberId],
          timezone: "America/Los_Angeles",
          local_time_source: "provider_timezone",
          refresh_version: 1,
          is_deleted: 0,
        },
      ],
      format: "JSONEachRow",
    });

    const startedAt = Date.parse("2026-06-15T15:00:00.000Z");
    const directSamples = Array.from({ length: 600 }, (_, elapsedSeconds) => ({
      activity_id: activityId,
      user_id: TEST_USER_ID,
      recorded_at: new Date(startedAt + elapsedSeconds * 1_000)
        .toISOString()
        .replace("T", " ")
        .replace("Z", ""),
      channel: "power",
      scalar: 150,
      provider_id: "wahoo",
      device_id: "elemnt-bolt",
      measurement_kind: "direct",
      refresh_version: 2,
      is_deleted: 0,
    }));
    const duplicateImports = directSamples.map((sample) => ({
      ...sample,
      provider_id: "strava",
      device_id: "strava-import",
      refresh_version: 1,
    }));
    await clickhouse.insert({
      table: `${analyticsDatabase}.activity_sensor_sample`,
      values: [...duplicateImports, ...directSamples],
      format: "JSONEachRow",
    });
    await clickhouse.insert({
      table: `${analyticsDatabase}.activity_power_curve`,
      values: [
        {
          activity_id: activityId,
          user_id: TEST_USER_ID,
          duration_seconds: 300,
          best_power: 150,
          start_offset_seconds: 0,
          observed_samples: 301,
          coverage_pct: 100,
          largest_gap_seconds: 1,
          median_sample_interval_seconds: 1,
          power_measurement_kind: "direct",
          refresh_version: 1,
          is_deleted: 0,
        },
      ],
      format: "JSONEachRow",
    });
  }, 60_000);

  afterAll(async () => {
    await clickhouse.command({ query: `DROP DATABASE IF EXISTS ${analyticsDatabase}` });
    await clickhouse.close?.();
    await postgres?.cleanup();
  });

  it("does not double work or duration for a merged duplicate activity", async () => {
    const result = await new CyclingTrainingMetricsRepository(
      postgres.db,
      store,
      TEST_USER_ID,
      "America/Los_Angeles",
    ).listRange({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      modalities: ["outdoor"],
      providers: ["strava"],
      durationsSeconds: [300],
      cursor: null,
      limit: 10,
    });

    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({
      activity_id: activityId,
      member_activity_ids: [activityId, duplicateMemberId],
      metrics: {
        power: {
          average_watts: 150,
          normalized_watts: 150,
          work_kilojoules: 90,
          intensity_factor: 0.6,
          training_stress_score: 6,
        },
        coverage: { power: { observed_samples: 600, covered_seconds: 600 } },
      },
      provenance: { duplicate_merged: true },
      best_powers: [{ duration_seconds: 300, watts: 150 }],
    });
  });

  it("loads deduplicated movement, signed environment, distance and nearby weight in the shared bundle", async () => {
    await clickhouse.insert({
      table: `${analyticsDatabase}.activity_sensor_sample`,
      values: [1, 2].flatMap((version) =>
        Array.from({ length: 600 }, (_, second) =>
          ["speed", "altitude", "temperature", "heart_rate", "cadence"].map((channel) => ({
            activity_id: activityId,
            user_id: TEST_USER_ID,
            recorded_at: new Date(Date.parse("2026-06-15T15:00:00Z") + second * 1000)
              .toISOString()
              .replace("T", " ")
              .replace("Z", ""),
            channel,
            scalar:
              version === 1
                ? 999
                : channel === "speed"
                  ? 10
                  : channel === "altitude"
                    ? -100 + second / 10
                    : channel === "heart_rate"
                      ? 140
                      : channel === "cadence"
                        ? 90
                        : -5,
            provider_id: channel === "heart_rate" ? "strap" : "sensor",
            device_id: channel === "cadence" ? null : `${channel}-device`,
            measurement_kind:
              channel === "speed" ? "estimated" : channel === "altitude" ? "unknown" : "direct",
            refresh_version: version,
            is_deleted: 0,
          })),
        ).flat(),
      ),
      format: "JSONEachRow",
    });
    await clickhouse.insert({
      table: `${analyticsDatabase}.activity_summary_rows`,
      values: [
        {
          activity_id: activityId,
          user_id: TEST_USER_ID,
          total_distance: 6000,
          refresh_version: 1,
          is_deleted: 0,
        },
      ],
      format: "JSONEachRow",
    });
    await clickhouse.insert({
      table: `${analyticsDatabase}.v_body_measurement`,
      values: [
        {
          user_id: TEST_USER_ID,
          recorded_at: "2026-06-15 10:00:00.000000",
          weight_kg: 75,
          provider_id: "scale",
          external_id: "weight",
        },
      ],
      format: "JSONEachRow",
    });
    const [result] = await loadCyclingEffortMetrics(
      postgres.db,
      store,
      TEST_USER_ID,
      "UTC",
      [
        {
          activity_id: activityId,
          member_activity_ids: [activityId, duplicateMemberId],
          started_at: "2026-06-15T15:00:00Z",
          activityDate: "2026-06-15",
          durationSeconds: 600,
          sourceProviders: ["sensor"],
          movingDuration: {
            seconds: null,
            status: "not_available",
            evidence: [],
            evidence_count: 0,
            evidence_truncated: false,
          },
        },
      ],
      [300],
    );
    expect(result?.metrics).toMatchObject({
      workout: { power: { averageWatts: 150, workKilojoules: 90 } },
      movement: { movingSeconds: 600, distanceMeters: 6000, averageMovingSpeedMetersPerSecond: 10 },
      environment: { averageTemperatureC: -5 },
      weight: { value_kg: 75, sources: [{ provider: "scale" }] },
      averageWattsPerKg: 2,
      bestPowers: [{ watts: 150, wattsPerKg: 2 }],
      streamQuality: { speed: { observedSamples: 600, coveragePct: 100 } },
    });
    expect(result?.metrics.movement.elevationGainMeters).toBeCloseTo(59.9);
    expect(result?.metrics.streamQuality).toMatchObject({
      heartRate: {
        measurementKinds: ["direct"],
        evidence: [
          { providerId: "strap", deviceId: "heart_rate-device", measurementKind: "direct" },
        ],
      },
      cadence: {
        measurementKinds: ["direct"],
        evidence: [{ providerId: "sensor", deviceId: null, measurementKind: "direct" }],
      },
      power: {
        measurementKinds: ["direct"],
        evidence: [{ providerId: "wahoo", deviceId: "elemnt-bolt", measurementKind: "direct" }],
      },
      speed: {
        measurementKinds: ["estimated"],
        evidence: [
          { providerId: "sensor", deviceId: "speed-device", measurementKind: "estimated" },
        ],
      },
      altitude: {
        measurementKinds: ["unknown"],
        evidence: [
          { providerId: "sensor", deviceId: "altitude-device", measurementKind: "unknown" },
        ],
      },
      temperature: {
        measurementKinds: ["direct"],
        evidence: [
          { providerId: "sensor", deviceId: "temperature-device", measurementKind: "direct" },
        ],
      },
    });
    expect(cyclingEffortMetricsSchema.safeParse(result?.metrics).success).toBe(true);
  });
});
