import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { AnalyticalTrainingLoadRepository } from "./analytical-training-load-repository.ts";
import { RecoveryActivityExposureRepository } from "./recovery-activity-exposure-repository.ts";

describe("AnalyticalTrainingLoadRepository database semantics", () => {
  const analyticsDatabase = `analytical_training_load_${randomUUID().replaceAll("-", "")}`;
  const clickhouse = createClickHouseClientFromEnv();
  const userId = randomUUID();
  const providerId = `analytical-load-${randomUUID()}`;
  const duplicateProviderId = `analytical-load-duplicate-${randomUUID()}`;
  const cyclingActivityId = randomUUID();
  const duplicateCyclingActivityId = randomUUID();
  const climbingActivityId = randomUUID();
  const fingerActivityId = randomUUID();
  const strengthActivityId = randomUUID();
  const unrelatedActivityId = randomUUID();
  const exerciseId = randomUUID();
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
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}::uuid, 'Analytical Training Load Fixture')
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id)
      VALUES
        (${providerId}, 'Primary analytical-load provider', ${userId}::uuid),
        (${duplicateProviderId}, 'Duplicate analytical-load provider', ${userId}::uuid)
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.sport_settings (
        user_id, sport, ftp, threshold_hr, power_zone_pcts, hr_zone_pcts, effective_from
      ) VALUES (
        ${userId}::uuid, 'cycling', 250, 175,
        '[0.55,0.75,0.9,1.05,1.2,1.5]'::jsonb,
        '[0.6,0.7,0.8,0.9]'::jsonb,
        '2026-01-01'
      )
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.activity (
        id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, perceived_exertion, raw
      ) VALUES
        (${cyclingActivityId}::uuid, ${cyclingActivityId}::uuid, ${providerId}, ${userId}::uuid, 'ride-primary',
          'cycling', 'cycling', '2026-06-15T15:00:00Z', '2026-06-15T16:00:00Z', 5, '{}'::jsonb),
        (${duplicateCyclingActivityId}::uuid, ${cyclingActivityId}::uuid, ${duplicateProviderId}, ${userId}::uuid,
          'ride-duplicate', 'cycling', 'cycling', '2026-06-15T15:00:00Z',
          '2026-06-15T16:00:00Z', 5, '{}'::jsonb),
        (${climbingActivityId}::uuid, ${climbingActivityId}::uuid, ${providerId}, ${userId}::uuid, 'climb',
          'climbing', 'rock_climbing', '2026-06-15T18:00:00Z',
          '2026-06-15T19:30:00Z', NULL, '{}'::jsonb),
        (${fingerActivityId}::uuid, ${fingerActivityId}::uuid, ${providerId}, ${userId}::uuid, 'finger',
          'hangboard', 'strength_training', '2026-06-15T20:00:00Z',
          '2026-06-15T20:15:00Z', NULL, '{}'::jsonb),
        (${strengthActivityId}::uuid, ${strengthActivityId}::uuid, ${providerId}, ${userId}::uuid, 'strength',
          'strength', 'strength_training', '2026-06-15T22:00:00Z',
          '2026-06-15T23:00:00Z', NULL, '{}'::jsonb),
        (${unrelatedActivityId}::uuid, ${unrelatedActivityId}::uuid, ${providerId}, ${userId}::uuid, 'walk',
          'walking', 'walking', '2026-06-16T15:00:00Z',
          '2026-06-16T16:00:00Z', NULL, '{}'::jsonb)
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.climbing_entry (
        activity_id, climb_type, grade_system, grade, sent, attempt_count
      ) VALUES
        (${climbingActivityId}::uuid, 'boulder', 'v_scale', 'V5', true, 3),
        (${climbingActivityId}::uuid, 'boulder', 'v_scale', 'V6', NULL, NULL)
    `);
    await postgres.db.execute(sql`
      UPDATE fitness.activity
      SET
        modality = 'indoor',
        started_at = '2026-06-16T00:30:00Z',
        ended_at = '2026-06-16T01:30:00Z',
        timezone = NULL,
        start_utc_offset_minutes = -420,
        end_utc_offset_minutes = -420,
        local_time_source = 'provider_offset'
      WHERE id IN (${cyclingActivityId}::uuid, ${duplicateCyclingActivityId}::uuid)
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.finger_loading_entry (
        activity_id, exercise, grip_position, external_load_kg, bodyweight_kg,
        laterality, set_count, hold_duration_seconds, rest_interval_seconds
      ) VALUES (
        ${fingerActivityId}::uuid, 'max_hang', 'half_crimp', 10, 70,
        'both', 5, 10, 120
      )
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.exercise (id, name, equipment)
      VALUES (${exerciseId}::uuid, 'Fixture squat', 'barbell')
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.strength_set (
        activity_id, exercise_id, exercise_index, set_index, set_type, weight_kg, reps
      ) VALUES
        (${strengthActivityId}::uuid, ${exerciseId}::uuid, 0, 0, 'working', 100, 5),
        (${strengthActivityId}::uuid, ${exerciseId}::uuid, 0, 1, 'working', 11, 140)
    `);

    await clickhouse.command({ query: `CREATE DATABASE ${analyticsDatabase}` });
    await clickhouse.command({
      query: `CREATE TABLE ${analyticsDatabase}.cycling_activity (
        activity_id UUID,
        user_id UUID,
        started_at DateTime64(6, 'UTC'),
        normalized_power Nullable(Float64),
        elapsed_seconds UInt32,
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
        modality Nullable(String),
        timezone Nullable(String),
        start_utc_offset_minutes Nullable(Int16),
        end_utc_offset_minutes Nullable(Int16),
        local_time_source String,
        source_providers Array(String),
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
        refresh_version UInt64,
        is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, channel, recorded_at)`,
    });
    await clickhouse.insert({
      table: `${analyticsDatabase}.cycling_activity`,
      values: [
        {
          activity_id: cyclingActivityId,
          user_id: userId,
          started_at: "2026-06-16 00:30:00.000000",
          normalized_power: 250,
          elapsed_seconds: 3600,
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
          activity_id: cyclingActivityId,
          user_id: userId,
          started_at: "2026-06-16 00:30:00.000000",
          modality: "indoor",
          timezone: null,
          start_utc_offset_minutes: -420,
          end_utc_offset_minutes: -420,
          local_time_source: "provider_offset",
          source_providers: [providerId, duplicateProviderId],
          refresh_version: 1,
          is_deleted: 0,
        },
      ],
      format: "JSONEachRow",
    });
    const startedAt = Date.parse("2026-06-16T00:30:00.000Z");
    await clickhouse.insert({
      table: `${analyticsDatabase}.activity_sensor_sample`,
      values: Array.from({ length: 361 }, (_, index) => ({
        activity_id: cyclingActivityId,
        user_id: userId,
        recorded_at: new Date(startedAt + index * 10_000)
          .toISOString()
          .replace("T", " ")
          .replace("Z", ""),
        channel: "heart_rate",
        scalar: 160,
        provider_id: providerId,
        refresh_version: 1,
        is_deleted: 0,
      })),
      format: "JSONEachRow",
    });
  }, 60_000);

  afterAll(async () => {
    await clickhouse.command({ query: `DROP DATABASE IF EXISTS ${analyticsDatabase}` });
    await clickhouse.close?.();
    await postgres?.cleanup();
  });

  it("executes both engines, deduplicates activity duration, and preserves modality units", async () => {
    const result = await new AnalyticalTrainingLoadRepository(
      postgres.db,
      store,
      userId,
      "UTC",
    ).listRange("2026-06-15", "2026-06-15", { providers: [], modalities: [] }, "source_context");

    expect(result.total_daily_load.value).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.channels).toMatchObject({
      cycling_power_tss: { daily_value: 100, unit: "TSS points" },
      heart_rate_zone_load: { daily_value: 300, unit: "weighted zone-minutes" },
      session_rpe: {
        daily_value: 300,
        unit: "RPE-minutes",
        status: "partial",
        source_providers: expect.arrayContaining([providerId, duplicateProviderId]),
        coverage: { contributing_records: 4, supported_records: 1 },
      },
      climbing_attempts: {
        daily_value: 3,
        status: "partial",
        coverage: { contributing_records: 2, supported_records: 1 },
      },
      finger_load: {
        daily_value: null,
        unit: "kg-seconds",
        status: "unavailable",
        reason:
          "Exact finger-load volume requires repetitions per set, which the canonical source schema does not record.",
      },
      strength_volume: {
        daily_value: 500,
        status: "partial",
        context: { working_sets: 1, suspicious_sets_excluded: 1 },
      },
    });
  });

  it("places near-midnight offset cycling exposure and load on the same canonical date", async () => {
    const [exposure, load] = await Promise.all([
      new RecoveryActivityExposureRepository(postgres.db, userId, "UTC").listDailyExposureRange(
        "2026-06-15",
        "2026-06-15",
        { providers: [], modalities: [] },
      ),
      new AnalyticalTrainingLoadRepository(postgres.db, store, userId, "UTC").listRange(
        "2026-06-15",
        "2026-06-15",
        { providers: [], modalities: [] },
        "source_context",
      ),
    ]);

    expect(exposure[0]).toMatchObject({
      date: "2026-06-15",
      modalities: expect.arrayContaining(["indoor"]),
      source_providers: expect.arrayContaining([providerId, duplicateProviderId]),
    });
    expect(load.rows[0]).toMatchObject({
      date: "2026-06-15",
      channels: {
        cycling_power_tss: {
          daily_value: 100,
          date_attribution: { authoritative_activities: 1, analysis_timezone_activities: 0 },
        },
        heart_rate_zone_load: {
          daily_value: 300,
          date_attribution: { authoritative_activities: 1, analysis_timezone_activities: 0 },
        },
        session_rpe: {
          date_attribution: { authoritative_activities: 1, analysis_timezone_activities: 3 },
        },
      },
    });
  });

  it("preserves analysis-timezone dating as the standalone repository default", async () => {
    const result = await new AnalyticalTrainingLoadRepository(
      postgres.db,
      store,
      userId,
      "UTC",
    ).listRange("2026-06-16", "2026-06-16");

    expect(result.range).toMatchObject({ timezone: "UTC", date_policy: "analysis_timezone" });
    expect(result.rows[0]?.channels).toMatchObject({
      cycling_power_tss: {
        daily_value: 100,
        date_attribution: { authoritative_activities: 0, analysis_timezone_activities: 1 },
      },
      heart_rate_zone_load: {
        daily_value: 300,
        date_attribution: { authoritative_activities: 0, analysis_timezone_activities: 1 },
      },
    });
  });

  it("applies provider and modality filters across both engines and coverage", async () => {
    const included = await new AnalyticalTrainingLoadRepository(
      postgres.db,
      store,
      userId,
      "UTC",
    ).listRange(
      "2026-06-15",
      "2026-06-15",
      {
        providers: [duplicateProviderId],
        modalities: ["indoor"],
      },
      "source_context",
    );
    expect(included.rows[0]?.channels).toMatchObject({
      cycling_power_tss: { daily_value: 100, status: "available" },
      heart_rate_zone_load: { daily_value: 300, status: "available" },
      session_rpe: { daily_value: 300, status: "available" },
      climbing_attempts: { daily_value: null, status: "unavailable" },
      finger_load: { daily_value: null, status: "unavailable" },
      strength_volume: { daily_value: null, status: "unavailable" },
    });

    const excluded = await new AnalyticalTrainingLoadRepository(
      postgres.db,
      store,
      userId,
      "UTC",
    ).listRange(
      "2026-06-15",
      "2026-06-15",
      {
        providers: [providerId],
        modalities: ["road"],
      },
      "source_context",
    );
    expect(Object.values(excluded.rows[0]?.channels ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ daily_value: null, status: "unavailable" }),
      ]),
    );
    expect(
      Object.entries(excluded.rows[0]?.channels ?? {}).map(([key, channel]) => [
        key,
        channel.daily_value,
        channel.status,
      ]),
    ).toEqual([
      ["cycling_power_tss", null, "unavailable"],
      ["heart_rate_zone_load", null, "unavailable"],
      ["session_rpe", null, "unavailable"],
      ["climbing_attempts", null, "unavailable"],
      ["finger_load", null, "unavailable"],
      ["strength_volume", null, "unavailable"],
    ]);
  });

  it("represents established modality coverage as zero on a day with no matching exposure", async () => {
    const result = await new AnalyticalTrainingLoadRepository(
      postgres.db,
      store,
      userId,
      "UTC",
    ).listRange("2026-06-16", "2026-06-16", { providers: [], modalities: [] }, "source_context");

    expect(result.rows[0]?.channels).toMatchObject({
      cycling_power_tss: { daily_value: 0, status: "not_observed" },
      heart_rate_zone_load: { daily_value: 0, status: "not_observed" },
      climbing_attempts: { daily_value: 0, status: "not_observed" },
      finger_load: { daily_value: 0, status: "not_observed" },
      strength_volume: { daily_value: 0, status: "not_observed" },
    });
  });
});
