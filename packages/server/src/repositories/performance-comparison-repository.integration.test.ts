import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { performanceComparisonOutputSchema } from "../mcp/performance-comparison-output.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { PerformanceComparisonRepository } from "./performance-comparison-repository.ts";

describe("PerformanceComparisonRepository database semantics", () => {
  const analyticsDatabase = `performance_comparison_${randomUUID().replaceAll("-", "")}`;
  const clickhouse = createClickHouseClientFromEnv();
  const userId = randomUUID();
  const pelotonProvider = "peloton";
  const mirrorProvider = `performance-mirror-${randomUUID()}`;
  const firstSourceId = randomUUID();
  const mirrorSourceId = randomUUID();
  const secondSourceId = randomUUID();
  const routeActivityIds = [randomUUID(), randomUUID()];
  const testActivityIds = [randomUUID(), randomUUID()];
  const namedActivityIds = [randomUUID(), randomUUID()];
  const climbBaselineIds = [randomUUID(), randomUUID()];
  const climbLatestIds = [randomUUID(), randomUUID()];
  const climbLeadId = randomUUID();
  const strengthBaselineIds = [randomUUID(), randomUUID()];
  const strengthLatestIds = [randomUUID(), randomUUID()];
  const exerciseId = randomUUID();
  let postgres: TestContext;
  let firstCanonicalId: string;
  let secondCanonicalId: string;
  let zeroSampleCanonicalId: string;
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
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}::uuid, 'Performance comparison fixture')
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id)
      VALUES
        (${pelotonProvider}, 'Peloton comparison fixture', ${userId}::uuid),
        (${mirrorProvider}, 'Mirror comparison fixture', ${userId}::uuid)
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.activity (
        id, group_id, provider_id, user_id, external_id, canonical_type, provider_type, modality,
        started_at, ended_at, name, raw, timezone,
        start_utc_offset_minutes, end_utc_offset_minutes, local_time_source
      ) VALUES
        (${firstSourceId}::uuid, ${firstSourceId}::uuid, ${pelotonProvider}, ${userId}::uuid, 'peloton-first',
          'cycling', 'cycling', 'indoor', '2026-06-01T17:00:00Z', '2026-06-01T17:30:00Z',
          '30 min Power Zone', '{"pelotonClassId":"class-abc","moving_time":1740}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${mirrorSourceId}::uuid, ${firstSourceId}::uuid, ${mirrorProvider}, ${userId}::uuid, 'mirror-first',
          'cycling', 'cycling', 'indoor', '2026-06-01T17:00:00Z', '2026-06-01T17:30:00Z',
          '30 min Power Zone mirror', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'device_timezone'),
        (${secondSourceId}::uuid, ${secondSourceId}::uuid, ${pelotonProvider}, ${userId}::uuid, 'peloton-second',
          'cycling', 'cycling', 'indoor', '2026-07-01T17:00:00Z', '2026-07-01T17:30:00Z',
          '30 min Power Zone', '{"pelotonClassId":"class-abc","moving_time":1720}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone')
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.activity (
        id, group_id, provider_id, user_id, external_id, canonical_type, provider_type, modality,
        started_at, ended_at, name, raw, timezone,
        start_utc_offset_minutes, end_utc_offset_minutes, local_time_source
      ) VALUES
        (${routeActivityIds[0]}::uuid, ${routeActivityIds[0]}::uuid, ${pelotonProvider}, ${userId}::uuid, 'route-first',
          'cycling', 'virtual_ride', 'indoor', '2026-08-01T17:00:00Z',
          '2026-08-01T18:00:00Z', 'Coastal loop', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${routeActivityIds[1]}::uuid, ${routeActivityIds[1]}::uuid, ${pelotonProvider}, ${userId}::uuid, 'route-second',
          'cycling', 'virtual_ride', 'indoor', '2026-08-08T17:00:00Z',
          '2026-08-08T18:00:00Z', ' coastal   LOOP ', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${testActivityIds[0]}::uuid, ${testActivityIds[0]}::uuid, ${pelotonProvider}, ${userId}::uuid, 'test-first',
          'cycling', 'cycling_test', 'indoor', '2026-08-10T17:00:00Z',
          '2026-08-10T17:20:00Z', '20 Minute FTP Test', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${testActivityIds[1]}::uuid, ${testActivityIds[1]}::uuid, ${pelotonProvider}, ${userId}::uuid, 'test-second',
          'cycling', 'cycling_test', 'indoor', '2026-08-17T17:00:00Z',
          '2026-08-17T17:20:00Z', ' 20 minute   ftp test ', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${namedActivityIds[0]}::uuid, ${namedActivityIds[0]}::uuid, ${pelotonProvider}, ${userId}::uuid, 'named-first',
          'running', 'running', 'road', '2026-08-20T17:00:00Z',
          '2026-08-20T17:30:00Z', 'Park Benchmark', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${namedActivityIds[1]}::uuid, ${namedActivityIds[1]}::uuid, ${mirrorProvider}, ${userId}::uuid, 'named-second',
          'running', 'running', 'road', '2026-08-27T17:00:00Z',
          '2026-08-27T17:29:00Z', ' park   benchmark ', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${climbBaselineIds[0]}::uuid, ${climbBaselineIds[0]}::uuid, ${pelotonProvider}, ${userId}::uuid, 'climb-base-a',
          'climbing', 'rock_climbing', 'indoor', '2026-09-01T17:00:00Z',
          '2026-09-01T18:00:00Z', 'Route session', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${climbBaselineIds[1]}::uuid, ${climbBaselineIds[0]}::uuid, ${mirrorProvider}, ${userId}::uuid, 'climb-base-b',
          'climbing', 'rock_climbing', 'indoor', '2026-09-01T17:00:00Z',
          '2026-09-01T18:00:00Z', 'Route session mirror', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${climbLatestIds[0]}::uuid, ${climbLatestIds[0]}::uuid, ${pelotonProvider}, ${userId}::uuid, 'climb-latest-a',
          'climbing', 'rock_climbing', 'indoor', '2026-09-08T17:00:00Z',
          '2026-09-08T18:00:00Z', 'Route session', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${climbLatestIds[1]}::uuid, ${climbLatestIds[0]}::uuid, ${mirrorProvider}, ${userId}::uuid, 'climb-latest-b',
          'climbing', 'rock_climbing', 'indoor', '2026-09-08T17:00:00Z',
          '2026-09-08T18:00:00Z', 'Route session mirror', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${climbLeadId}::uuid, ${climbLeadId}::uuid, ${pelotonProvider}, ${userId}::uuid, 'climb-lead',
          'climbing', 'rock_climbing', 'indoor', '2026-09-15T17:00:00Z',
          '2026-09-15T18:00:00Z', 'Lead route session', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${strengthBaselineIds[0]}::uuid, ${strengthBaselineIds[0]}::uuid, ${pelotonProvider}, ${userId}::uuid, 'strength-base-a',
          'strength', 'strength_training', 'indoor', '2026-09-20T17:00:00Z',
          '2026-09-20T18:00:00Z', 'Bench baseline', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${strengthBaselineIds[1]}::uuid, ${strengthBaselineIds[0]}::uuid, ${mirrorProvider}, ${userId}::uuid, 'strength-base-b',
          'strength', 'strength_training', 'indoor', '2026-09-20T17:00:00Z',
          '2026-09-20T18:00:00Z', 'Bench baseline mirror', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${strengthLatestIds[0]}::uuid, ${strengthLatestIds[0]}::uuid, ${pelotonProvider}, ${userId}::uuid, 'strength-latest-a',
          'strength', 'strength_training', 'indoor', '2026-09-27T17:00:00Z',
          '2026-09-27T18:00:00Z', 'Bench latest', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${strengthLatestIds[1]}::uuid, ${strengthLatestIds[0]}::uuid, ${mirrorProvider}, ${userId}::uuid, 'strength-latest-b',
          'strength', 'strength_training', 'indoor', '2026-09-27T17:00:00Z',
          '2026-09-27T18:00:00Z', 'Bench latest mirror', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone')
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.climbing_entry (
        activity_id, external_id, climb_type, grade_system, grade, sent, attempt_count,
        lead, wall_angle_degrees, route_name, location_name
      ) VALUES
        (${climbBaselineIds[0]}::uuid, 'route-base-a', 'route', 'yds', '5.11a', true, 2,
          false, 10, 'Red Corner', 'Test Gym'),
        (${climbBaselineIds[1]}::uuid, 'route-base-b', 'route', 'yds', '5.11a', true, 2,
          false, 10, 'Red Corner', 'Test Gym'),
        (${climbLatestIds[0]}::uuid, 'route-latest-a', 'route', 'yds', '5.11a', true, 1,
          false, 10, 'Red Corner', 'Test Gym'),
        (${climbLatestIds[1]}::uuid, 'route-latest-b', 'route', 'yds', '5.11a', false, 3,
          false, 10, 'Red Corner', 'Test Gym'),
        (${climbLeadId}::uuid, 'route-lead', 'route', 'yds', '5.11a', true, 1,
          true, 10, 'Red Corner', 'Test Gym')
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.exercise (id, name, equipment)
      VALUES (${exerciseId}::uuid, 'Performance comparison bench', 'barbell')
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.strength_set (
        activity_id, exercise_id, exercise_index, set_index, set_type, weight_kg, reps, rpe
      ) VALUES
        (${strengthBaselineIds[0]}::uuid, ${exerciseId}::uuid, 0, 0, 'working', 100, 5, 8),
        (${strengthBaselineIds[1]}::uuid, ${exerciseId}::uuid, 0, 0, 'working', 100, 5, 8),
        (${strengthLatestIds[0]}::uuid, ${exerciseId}::uuid, 0, 0, 'working', 110, 5, 9),
        (${strengthLatestIds[1]}::uuid, ${exerciseId}::uuid, 0, 0, 'working', 110, 8, 9)
    `);
    const canonicalRows = await postgres.db.execute(sql`
      SELECT id::text AS id, started_at::text AS started_at, source_providers
      FROM fitness.v_activity
      WHERE user_id = ${userId}::uuid
        AND started_at < '2026-08-01T00:00:00Z'
      ORDER BY started_at
    `);
    expect(canonicalRows).toHaveLength(2);
    firstCanonicalId = String(canonicalRows[0]?.id);
    secondCanonicalId = String(canonicalRows[1]?.id);
    expect(canonicalRows[0]?.source_providers).toEqual(
      expect.arrayContaining([pelotonProvider, mirrorProvider]),
    );
    const zeroSampleRows = await postgres.db.execute(sql`
      SELECT id::text AS id
      FROM fitness.v_activity
      WHERE user_id = ${userId}::uuid
        AND ${routeActivityIds[0]}::uuid = ANY(member_activity_ids)
    `);
    zeroSampleCanonicalId = String(zeroSampleRows[0]?.id);

    await clickhouse.command({ query: `CREATE DATABASE ${analyticsDatabase}` });
    await clickhouse.command({
      query: `CREATE TABLE ${analyticsDatabase}.activity_summary_rows (
        activity_id UUID,
        user_id UUID,
        avg_power Nullable(Float64),
        normalized_power Nullable(Float64),
        avg_hr Nullable(Float64),
        max_hr Nullable(Float64),
        avg_cadence Nullable(Float64),
        total_distance Nullable(Float64),
        elevation_gain_m Nullable(Float64),
        sample_count Nullable(UInt32),
        power_sample_count Nullable(UInt32),
        hr_sample_count Nullable(UInt32),
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
        refresh_version UInt64,
        is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, channel, recorded_at)`,
    });
    await clickhouse.insert({
      table: `${analyticsDatabase}.activity_summary_rows`,
      values: [
        {
          activity_id: firstCanonicalId,
          user_id: userId,
          avg_power: 180,
          normalized_power: 185,
          avg_hr: 145,
          max_hr: 165,
          avg_cadence: 88,
          total_distance: 15_000,
          elevation_gain_m: 0,
          sample_count: 360,
          power_sample_count: 360,
          hr_sample_count: 360,
          refresh_version: 1,
          is_deleted: 0,
        },
        {
          activity_id: secondCanonicalId,
          user_id: userId,
          avg_power: 195,
          normalized_power: 200,
          avg_hr: 143,
          max_hr: 163,
          avg_cadence: 90,
          total_distance: 15_000,
          elevation_gain_m: 0,
          sample_count: 360,
          power_sample_count: 360,
          hr_sample_count: 360,
          refresh_version: 1,
          is_deleted: 0,
        },
        {
          activity_id: zeroSampleCanonicalId,
          user_id: userId,
          avg_power: null,
          normalized_power: null,
          avg_hr: null,
          max_hr: null,
          avg_cadence: null,
          total_distance: 0,
          elevation_gain_m: 0,
          sample_count: null,
          power_sample_count: null,
          hr_sample_count: null,
          refresh_version: 1,
          is_deleted: 0,
        },
      ],
      format: "JSONEachRow",
    });
    await clickhouse.insert({
      table: `${analyticsDatabase}.activity_sensor_sample`,
      values: [
        {
          activity_id: firstCanonicalId,
          user_id: userId,
          recorded_at: "2026-06-01 17:05:00.000000",
          channel: "temperature",
          scalar: 20,
          provider_id: pelotonProvider,
          device_id: "bike-1",
          refresh_version: 1,
          is_deleted: 0,
        },
        {
          activity_id: secondCanonicalId,
          user_id: userId,
          recorded_at: "2026-07-01 17:05:00.000000",
          channel: "temperature",
          scalar: 18,
          provider_id: pelotonProvider,
          device_id: "bike-1",
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

  it("compares repeated workouts once after canonical deduplication", async () => {
    const result = await new PerformanceComparisonRepository(
      postgres.db,
      store,
      userId,
      "UTC",
    ).compare({
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: firstCanonicalId,
      equivalence: {
        kind: "provider_workout_id",
        provider: pelotonProvider,
        value: "class-abc",
      },
      providers: [pelotonProvider],
      modalities: ["indoor"],
      cursor: null,
      limit: 25,
    });
    expect(() => performanceComparisonOutputSchema.parse({ result })).not.toThrow();

    expect(result.performances).toHaveLength(2);
    expect(result.baseline.activity_id).toBe(firstCanonicalId);
    expect(result.performances[0]?.source_providers).toEqual(
      expect.arrayContaining([pelotonProvider, mirrorProvider]),
    );
    expect(result.performances[1]).toMatchObject({
      activity_id: secondCanonicalId,
      delta_to_baseline: {
        average_power_watts: 15,
        average_heart_rate_bpm: -2,
        average_temperature_c: -2,
        moving_duration_seconds: -20,
      },
      provenance: {
        sample_source_providers: [pelotonProvider],
        sample_device_ids: ["bike-1"],
      },
    });
    expect(result.performances[0]?.moving_duration).toMatchObject({
      seconds: 1740,
      status: "available",
      evidence: [{ provider: pelotonProvider, source_activity_id: firstSourceId }],
    });
    expect(result.coverage.canonical_activities).toBe(2);
  });

  it("executes cycling-route, standardized-test, and exact-name predicates", async () => {
    const repository = new PerformanceComparisonRepository(postgres.db, store, userId, "UTC");
    const route = await repository.compare({
      startDate: "2026-08-01",
      endDate: "2026-08-08",
      referenceActivityId: null,
      equivalence: {
        kind: "cycling_route",
        provider: pelotonProvider,
        activityName: "Coastal loop",
        providerType: "virtual_ride",
      },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 25,
    });
    expect(() => performanceComparisonOutputSchema.parse({ result: route })).not.toThrow();
    expect(route.performances).toHaveLength(2);
    expect(route.coverage.cycling_metrics_from_deduped_samples).toBe(0);
    expect(route.performances[0]).toMatchObject({
      quality: { flags: expect.arrayContaining(["cycling_sensor_summary_unavailable"]) },
      metrics: {
        cycling: {
          sample_coverage: {
            total_samples: null,
            power_samples: null,
            heart_rate_samples: null,
            status: "not_available",
          },
        },
      },
    });
    expect(route.performances[0]).toMatchObject({
      route: {
        status: "caller_asserted",
        provider: pelotonProvider,
        activity_name: "Coastal loop",
        provider_type: "virtual_ride",
      },
      equivalence_evidence: [
        {
          evidence_type: "cycling_route_name_provider_type",
          provider: pelotonProvider,
          provider_type: "virtual_ride",
        },
      ],
    });

    const standardizedTest = await repository.compare({
      startDate: "2026-08-10",
      endDate: "2026-08-17",
      referenceActivityId: null,
      equivalence: {
        kind: "standardized_test",
        provider: pelotonProvider,
        activityName: "20 minute FTP test",
        providerType: "cycling_test",
      },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 25,
    });
    expect(() =>
      performanceComparisonOutputSchema.parse({ result: standardizedTest }),
    ).not.toThrow();
    expect(standardizedTest.performances).toHaveLength(2);
    expect(standardizedTest.performances[1]?.equivalence_evidence).toEqual([
      expect.objectContaining({
        evidence_type: "standardized_test_name_provider_type",
        provider: pelotonProvider,
        provider_type: "cycling_test",
      }),
    ]);

    const named = await repository.compare({
      startDate: "2026-08-20",
      endDate: "2026-08-27",
      referenceActivityId: null,
      equivalence: {
        kind: "activity_name",
        canonicalType: "running",
        value: "Park Benchmark",
      },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 25,
    });
    expect(() => performanceComparisonOutputSchema.parse({ result: named })).not.toThrow();
    expect(named.performances).toHaveLength(2);
    expect(named.equivalence).toMatchObject({ confidence: "user_asserted" });
  });

  it("matches climb discipline exactly and attributes cross-member conflicts", async () => {
    const result = await new PerformanceComparisonRepository(
      postgres.db,
      store,
      userId,
      "UTC",
    ).compare({
      startDate: "2026-09-01",
      endDate: "2026-09-15",
      referenceActivityId: null,
      equivalence: {
        kind: "climb",
        climbType: "route",
        gradeSystem: "yds",
        grade: "5.11a",
        routeName: "Red Corner",
        locationName: "Test Gym",
        lead: false,
      },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 25,
    });
    expect(() => performanceComparisonOutputSchema.parse({ result })).not.toThrow();

    expect(result.performances).toHaveLength(2);
    expect(result.performances[0]?.metrics.climbing).toMatchObject({
      source_entries: 2,
      entries: 1,
      excluded_ambiguous_entries: 0,
      attempts: 2,
      evidence: [{ merged_duplicate: true, lead: false }],
    });
    expect(result.performances[1]).toMatchObject({
      metrics: {
        climbing: {
          source_entries: 2,
          entries: 0,
          excluded_ambiguous_entries: 2,
          attempts: null,
          outcomes_status: "unavailable",
        },
      },
      delta_to_baseline: { climbing_attempts: null, climbing_sends: null },
    });
  });

  it("joins strength sets through canonical members and gates conflicting deltas", async () => {
    const result = await new PerformanceComparisonRepository(
      postgres.db,
      store,
      userId,
      "UTC",
    ).compare({
      startDate: "2026-09-20",
      endDate: "2026-09-27",
      referenceActivityId: null,
      equivalence: { kind: "strength_exercise_id", exerciseId },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 25,
    });
    expect(() => performanceComparisonOutputSchema.parse({ result })).not.toThrow();

    expect(result.performances).toHaveLength(2);
    expect(result.performances[0]?.metrics.strength).toMatchObject({
      source_sets: 2,
      sets: 1,
      valid_volume_kg_reps: 500,
      volume_status: "complete",
    });
    expect(result.performances[1]).toMatchObject({
      metrics: {
        strength: {
          source_sets: 2,
          sets: 2,
          valid_volume_kg_reps: null,
          volume_status: "unavailable",
          excluded_sets: 2,
        },
      },
      delta_to_baseline: {
        strength_volume_kg_reps: null,
        strength_estimated_one_rep_max_kg: null,
      },
    });
  });
});
