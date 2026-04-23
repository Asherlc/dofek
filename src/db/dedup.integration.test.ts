import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshDedupViews } from "./dedup.ts";
import { loadProviderPriorityConfig, syncProviderPriorities } from "./provider-priority.ts";
import { activity, bodyMeasurement, dailyMetrics, sleepSession, TEST_USER_ID } from "./schema.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";

interface ActivityViewRow extends Record<string, unknown> {
  id: string;
  provider_id: string;
  primary_activity_id: string;
  activity_type: string;
  started_at: Date;
  ended_at: Date | null;
  name: string | null;
  notes: string | null;
  raw: Record<string, unknown> | null;
  source_providers: string[];
}

interface SleepViewRow extends Record<string, unknown> {
  id: string;
  provider_id: string;
  started_at: Date;
  ended_at: Date | null;
  duration_minutes: number | null;
  deep_minutes: number | null;
  rem_minutes: number | null;
  light_minutes: number | null;
  awake_minutes: number | null;
  efficiency_pct: number | null;
  is_nap: boolean;
  source_providers: string[];
}

interface BodyMeasurementViewRow extends Record<string, unknown> {
  id: string;
  provider_id: string;
  recorded_at: Date;
  weight_kg: number | null;
  body_fat_pct: number | null;
  muscle_mass_kg: number | null;
  bmi: number | null;
  systolic_bp: number | null;
  diastolic_bp: number | null;
  temperature_c: number | null;
  height_cm: number | null;
  source_providers: string[];
}

interface DailyMetricsViewRow extends Record<string, unknown> {
  date: string;
  resting_hr: number | null;
  hrv: number | string | null;
  vo2max: number | string | null;
  spo2_avg: number | string | null;
  respiratory_rate_avg: number | string | null;
  skin_temp_c: number | string | null;
  steps: number | null;
  active_energy_kcal: number | string | null;
  basal_energy_kcal: number | string | null;
  distance_km: number | string | null;
  flights_climbed: number | null;
  exercise_minutes: number | null;
  stand_hours: number | null;
  walking_speed: number | string | null;
  source_providers: string[];
}

interface ActivitySummaryRow extends Record<string, unknown> {
  activity_id: string;
  user_id: string;
  activity_type: string;
  started_at: Date;
  ended_at: Date | null;
  name: string | null;
  avg_hr: number | null;
  max_hr: number | null;
  min_hr: number | null;
  avg_power: number | null;
  max_power: number | null;
  avg_speed: number | null;
  max_speed: number | null;
  avg_cadence: number | null;
  total_distance: number | null;
  max_altitude: number | null;
  min_altitude: number | null;
  sample_count: number;
  hr_sample_count: number;
  power_sample_count: number;
  first_sample_at: Date | null;
  last_sample_at: Date | null;
}

interface DedupedSensorRow extends Record<string, unknown> {
  activity_id: string;
  channel: string;
  recorded_at: string;
  scalar: number;
}

describe("Deduplication materialized views", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    // Seed providers
    await ensureProvider(ctx.db, "wahoo", "Wahoo");
    await ensureProvider(ctx.db, "whoop", "WHOOP");
    await ensureProvider(ctx.db, "apple_health", "Apple Health");
    await ensureProvider(ctx.db, "withings", "Withings");
    // Apply per-category priorities from config file
    const priorityConfig = loadProviderPriorityConfig();
    if (priorityConfig) {
      await syncProviderPriorities(ctx.db, priorityConfig);
    }
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it("v_activity merges overlapping activities by provider priority", async () => {
    // Same morning run recorded by 3 providers
    await ctx.db.insert(activity).values([
      {
        providerId: "wahoo",
        externalId: "wahoo-run-1",
        activityType: "running",
        startedAt: new Date("2026-03-01T10:00:00Z"),
        endedAt: new Date("2026-03-01T11:00:00Z"),
        name: "Morning Run",
        raw: { avgPower: 220, tss: 78 },
      },
      {
        providerId: "whoop",
        externalId: "whoop-run-1",
        activityType: "running",
        startedAt: new Date("2026-03-01T10:00:30Z"), // 30s offset
        endedAt: new Date("2026-03-01T10:59:00Z"),
        name: null, // WHOOP doesn't have names
        raw: { strain: 12.5, avgHeartRate: 155 },
      },
      {
        providerId: "apple_health",
        externalId: "ah-run-1",
        activityType: "running",
        startedAt: new Date("2026-03-01T10:00:00Z"),
        endedAt: new Date("2026-03-01T11:00:00Z"),
        name: "Running",
        raw: { source: "Apple Watch" },
      },
    ]);

    // A separate afternoon yoga — should NOT merge with the run
    await ctx.db.insert(activity).values({
      providerId: "whoop",
      externalId: "whoop-yoga-1",
      activityType: "yoga",
      startedAt: new Date("2026-03-01T17:00:00Z"),
      endedAt: new Date("2026-03-01T18:00:00Z"),
      raw: { strain: 5.2 },
    });

    await refreshDedupViews(ctx.db);

    const rows = await ctx.db.execute<ActivityViewRow>(
      sql`SELECT * FROM fitness.v_activity ORDER BY started_at`,
    );

    // Should have 2 canonical activities: merged run + standalone yoga
    expect(rows.length).toBe(2);

    const run = rows.find((r) => r.activity_type === "running");
    expect(run).toBeDefined();
    // Wahoo is highest priority (10), should be the primary
    expect(run?.provider_id).toBe("wahoo");
    // Name should come from Wahoo (highest priority with non-null name)
    expect(run?.name).toBe("Morning Run");
    // source_providers should include all 3
    expect(run?.source_providers).toContain("wahoo");
    expect(run?.source_providers).toContain("whoop");
    expect(run?.source_providers).toContain("apple_health");
    // raw should be merged JSONB (wahoo fields win on conflict)
    const raw = typeof run?.raw === "string" ? JSON.parse(run.raw) : run?.raw;
    expect(raw?.avgPower).toBe(220);
    expect(raw?.strain).toBe(12.5); // from WHOOP, no conflict with wahoo

    const yoga = rows.find((r) => r.activity_type === "yoga");
    expect(yoga).toBeDefined();
    expect(yoga?.provider_id).toBe("whoop");
    expect(yoga?.source_providers).toHaveLength(1);
  });

  it("v_activity dedupes overlapping activities with different activity types", async () => {
    // Same outdoor ride recorded by Wahoo as "cycling" and RideWithGPS as "other"
    await ensureProvider(ctx.db, "ride-with-gps", "RideWithGPS");
    await ctx.db.insert(activity).values([
      {
        providerId: "wahoo",
        externalId: "wahoo-ride-cross-type",
        activityType: "cycling",
        startedAt: new Date("2026-03-14T18:16:28Z"),
        endedAt: new Date("2026-03-14T19:47:39Z"),
        name: "Cycling",
      },
      {
        providerId: "ride-with-gps",
        externalId: "rwgps-ride-cross-type",
        activityType: "other",
        startedAt: new Date("2026-03-14T18:16:28Z"),
        endedAt: new Date("2026-03-14T19:47:38Z"),
        name: "03/14/26",
      },
    ]);

    await refreshDedupViews(ctx.db);

    const rows = await ctx.db.execute<ActivityViewRow>(
      sql`SELECT * FROM fitness.v_activity WHERE started_at::date = '2026-03-14'`,
    );

    // Should merge into 1 activity — Wahoo wins (priority 10)
    expect(rows.length).toBe(1);
    expect(rows[0]?.provider_id).toBe("wahoo");
    expect(rows[0]?.activity_type).toBe("cycling");
    expect(rows[0]?.source_providers).toContain("wahoo");
    expect(rows[0]?.source_providers).toContain("ride-with-gps");
  });

  it("v_activity dedupes WHOOP and Apple Health with different type names", async () => {
    // WHOOP records "walking", Apple Health republishes it as "other"
    await ctx.db.insert(activity).values([
      {
        providerId: "whoop",
        externalId: "whoop-commute-cross-type",
        activityType: "walking",
        startedAt: new Date("2026-03-12T15:21:00Z"),
        endedAt: new Date("2026-03-12T15:36:00Z"),
      },
      {
        providerId: "apple_health",
        externalId: "ah-whoop-commute-cross-type",
        activityType: "other",
        startedAt: new Date("2026-03-12T15:21:00Z"),
        endedAt: new Date("2026-03-12T15:36:00Z"),
        sourceName: "WHOOP",
      },
    ]);

    await refreshDedupViews(ctx.db);

    const rows = await ctx.db.execute<ActivityViewRow>(
      sql`SELECT * FROM fitness.v_activity
          WHERE started_at >= '2026-03-12T15:00:00Z' AND started_at < '2026-03-12T16:00:00Z'`,
    );

    // Should merge into 1 activity — WHOOP wins (priority 30 < 90)
    expect(rows.length).toBe(1);
    expect(rows[0]?.provider_id).toBe("whoop");
    expect(rows[0]?.activity_type).toBe("walking");
  });

  it("v_activity keeps non-overlapping same-type activities separate", async () => {
    // Morning run and evening run — same type but no overlap
    await ctx.db.insert(activity).values([
      {
        providerId: "wahoo",
        externalId: "wahoo-am-run",
        activityType: "running",
        startedAt: new Date("2026-03-10T07:00:00Z"),
        endedAt: new Date("2026-03-10T08:00:00Z"),
      },
      {
        providerId: "wahoo",
        externalId: "wahoo-pm-run",
        activityType: "running",
        startedAt: new Date("2026-03-10T18:00:00Z"),
        endedAt: new Date("2026-03-10T19:00:00Z"),
      },
    ]);

    await refreshDedupViews(ctx.db);

    const rows = await ctx.db.execute<ActivityViewRow>(
      sql`SELECT * FROM fitness.v_activity WHERE started_at::date = '2026-03-10'`,
    );

    expect(rows.length).toBe(2);
  });

  it("v_sleep merges overlapping sleep sessions", async () => {
    await ctx.db.insert(sleepSession).values([
      {
        providerId: "whoop",
        externalId: "whoop-sleep-1",
        startedAt: new Date("2026-03-01T23:00:00Z"),
        endedAt: new Date("2026-03-02T06:30:00Z"),
        durationMinutes: 420,
        deepMinutes: 120,
        remMinutes: 90,
        lightMinutes: 180,
        awakeMinutes: 30,
        efficiencyPct: 91.7,
        sleepType: "sleep",
      },
      {
        providerId: "apple_health",
        externalId: "ah-sleep-1",
        startedAt: new Date("2026-03-01T23:05:00Z"),
        endedAt: new Date("2026-03-02T06:25:00Z"),
        durationMinutes: 410,
        deepMinutes: 115,
        remMinutes: 85,
        lightMinutes: 175,
        awakeMinutes: 35,
        efficiencyPct: 89.0,
        sleepType: "sleep",
      },
    ]);

    await refreshDedupViews(ctx.db);

    const rows = await ctx.db.execute<SleepViewRow>(
      sql`SELECT * FROM fitness.v_sleep WHERE started_at::date >= '2026-03-01' AND started_at::date <= '2026-03-02'`,
    );

    // Should merge into 1 canonical sleep session
    const mainSleep = rows.filter((r) => !r.is_nap);
    expect(mainSleep.length).toBe(1);
    // WHOOP should win (priority 30 < apple_health 90)
    expect(mainSleep[0]?.provider_id).toBe("whoop");
    expect(mainSleep[0]?.deep_minutes).toBe(120);
    expect(mainSleep[0]?.source_providers).toContain("whoop");
    expect(mainSleep[0]?.source_providers).toContain("apple_health");
  });

  it("v_body_measurement merges measurements within 5 minutes", async () => {
    await ctx.db.insert(bodyMeasurement).values([
      {
        providerId: "withings",
        externalId: "withings-1",
        recordedAt: new Date("2026-03-01T08:00:00Z"),
        weightKg: 75.2,
        bodyFatPct: 18.5,
        muscleMassKg: 35.1,
      },
      {
        providerId: "apple_health",
        externalId: "ah-weight-1",
        recordedAt: new Date("2026-03-01T08:02:00Z"), // 2 minutes later
        weightKg: 75.2,
        bodyFatPct: null, // Apple Health may not get body fat
        muscleMassKg: null,
      },
    ]);

    await refreshDedupViews(ctx.db);

    const rows = await ctx.db.execute<BodyMeasurementViewRow>(
      sql`SELECT * FROM fitness.v_body_measurement WHERE recorded_at::date = '2026-03-01'`,
    );

    expect(rows.length).toBe(1);
    const measurement = rows[0];
    expect(measurement).toBeDefined();
    // Withings wins (priority 15)
    expect(measurement?.provider_id).toBe("withings");
    expect(measurement?.weight_kg).toBeCloseTo(75.2);
    // Body fat from Withings (Apple Health was null)
    expect(measurement?.body_fat_pct).toBeCloseTo(18.5);
    expect(measurement?.source_providers).toContain("withings");
    expect(measurement?.source_providers).toContain("apple_health");
  });

  it("v_daily_metrics merges per-field across providers", async () => {
    await ctx.db.insert(dailyMetrics).values([
      {
        date: "2026-03-01",
        providerId: "whoop",
        restingHr: 52,
        hrv: 65.5,
        spo2Avg: 97.2,
        skinTempC: 33.7,
        // WHOOP doesn't track steps
        steps: null,
      },
      {
        date: "2026-03-01",
        providerId: "apple_health",
        restingHr: 54, // slightly different
        hrv: 62.0,
        steps: 8421,
        activeEnergyKcal: 450,
        flightsClimbed: 12,
      },
    ]);

    await refreshDedupViews(ctx.db);

    const rows = await ctx.db.execute<DailyMetricsViewRow>(
      sql`SELECT * FROM fitness.v_daily_metrics WHERE date = '2026-03-01'`,
    );

    expect(rows.length).toBe(1);
    const day = rows[0];
    expect(day).toBeDefined();
    // WHOOP wins for restingHr/hrv/spo2 (priority 30 < 90)
    expect(day?.resting_hr).toBe(52);
    expect(Number(day?.hrv)).toBeCloseTo(65.5);
    expect(Number(day?.spo2_avg)).toBeCloseTo(97.2);
    expect(Number(day?.skin_temp_c)).toBeCloseTo(33.7);
    // Apple Health wins for steps (WHOOP was null)
    expect(day?.steps).toBe(8421);
    expect(Number(day?.active_energy_kcal)).toBeCloseTo(450);
    expect(day?.flights_climbed).toBe(12);
    // Both providers listed
    expect(day?.source_providers).toContain("whoop");
    expect(day?.source_providers).toContain("apple_health");
  });

  it("activity_summary aggregates per-activity stats from metric_stream", async () => {
    // Create an activity with metric streams
    const wahooActivityRows = await ctx.db
      .insert(activity)
      .values({
        providerId: "wahoo",
        externalId: "wahoo-ride-ms",
        activityType: "cycling",
        startedAt: new Date("2026-03-05T10:00:00Z"),
        endedAt: new Date("2026-03-05T11:00:00Z"),
      })
      .returning({ id: activity.id });
    const wahooActivity = wahooActivityRows[0];
    if (!wahooActivity) throw new Error("Expected wahoo activity row");

    // Wahoo stream — has power data
    await ctx.db.execute(
      sql`INSERT INTO fitness.metric_stream
          (recorded_at, user_id, provider_id, source_type, channel, activity_id, scalar)
          VALUES
          ('2026-03-05T10:00:00Z', ${TEST_USER_ID}, 'wahoo', 'api', 'heart_rate', ${wahooActivity.id}, 140),
          ('2026-03-05T10:00:00Z', ${TEST_USER_ID}, 'wahoo', 'api', 'power', ${wahooActivity.id}, 200),
          ('2026-03-05T10:00:06Z', ${TEST_USER_ID}, 'wahoo', 'api', 'heart_rate', ${wahooActivity.id}, 145),
          ('2026-03-05T10:00:06Z', ${TEST_USER_ID}, 'wahoo', 'api', 'power', ${wahooActivity.id}, 210)`,
    );

    await refreshDedupViews(ctx.db);

    const rows = await ctx.db.execute<ActivitySummaryRow>(
      sql`SELECT * FROM fitness.activity_summary WHERE activity_id = ${wahooActivity.id}`,
    );

    expect(rows.length).toBe(1);
    const summary = rows[0];
    expect(summary).toBeDefined();
    expect(summary?.activity_type).toBe("cycling");
    expect(Number(summary?.avg_hr)).toBeCloseTo(142.5, 0);
    expect(summary?.max_hr).toBe(145);
    expect(Number(summary?.avg_power)).toBeCloseTo(205, 0);
    expect(summary?.max_power).toBe(210);
    expect(summary?.sample_count).toBe(4);
    expect(summary?.hr_sample_count).toBe(2);
    expect(summary?.power_sample_count).toBe(2);
  });

  it("activity_summary falls back to ambient heart rate up to last linked sample when ended_at is null", async () => {
    const testExternalId = `wahoo-open-ended-ambient-hr-${randomUUID()}`;
    const activityRows = await ctx.db
      .insert(activity)
      .values({
        providerId: "wahoo",
        externalId: testExternalId,
        activityType: "cycling",
        startedAt: new Date("2026-03-06T10:00:00Z"),
        endedAt: null,
      })
      .returning({ id: activity.id });
    const testActivity = activityRows[0];
    if (!testActivity) throw new Error("Expected activity row");

    // Linked sample establishes the fallback window end (10:20).
    await ctx.db.execute(
      sql`INSERT INTO fitness.metric_stream
          (recorded_at, user_id, provider_id, source_type, channel, activity_id, scalar)
          VALUES
          ('2026-03-06T10:20:00Z', ${TEST_USER_ID}, 'wahoo', 'api', 'power', ${testActivity.id}, 230)`,
    );

    // Ambient HR (activity_id NULL): only samples within [started_at, last_linked_sample_at]
    // should be used for fallback.
    await ctx.db.execute(
      sql`INSERT INTO fitness.metric_stream
          (recorded_at, user_id, provider_id, source_type, channel, activity_id, scalar)
          VALUES
          ('2026-03-06T09:59:00Z', ${TEST_USER_ID}, 'apple_health', 'api', 'heart_rate', NULL, 120),
          ('2026-03-06T10:05:00Z', ${TEST_USER_ID}, 'apple_health', 'api', 'heart_rate', NULL, 140),
          ('2026-03-06T10:18:00Z', ${TEST_USER_ID}, 'apple_health', 'api', 'heart_rate', NULL, 150),
          ('2026-03-06T10:25:00Z', ${TEST_USER_ID}, 'apple_health', 'api', 'heart_rate', NULL, 160)`,
    );

    await refreshDedupViews(ctx.db);

    const summaryRows = await ctx.db.execute<ActivitySummaryRow>(
      sql`SELECT * FROM fitness.activity_summary WHERE activity_id = ${testActivity.id}`,
    );
    const summary = summaryRows[0];
    expect(summary).toBeDefined();
    expect(summary?.hr_sample_count).toBe(2);
    expect(Number(summary?.avg_hr)).toBeCloseTo(145, 0);
    expect(summary?.max_hr).toBe(150);

    const dedupedRows = await ctx.db.execute<DedupedSensorRow>(
      sql`SELECT activity_id, channel, recorded_at, scalar
          FROM fitness.deduped_sensor
          WHERE activity_id = ${testActivity.id} AND channel = 'heart_rate'
          ORDER BY recorded_at`,
    );
    expect(dedupedRows).toHaveLength(2);
    expect(new Date(dedupedRows[0]?.recorded_at ?? "").toISOString()).toBe(
      "2026-03-06T10:05:00.000Z",
    );
    expect(new Date(dedupedRows[1]?.recorded_at ?? "").toISOString()).toBe(
      "2026-03-06T10:18:00.000Z",
    );
  });

  it("refreshDedupViews can be called multiple times", async () => {
    // Should not error on second refresh (CONCURRENTLY)
    await refreshDedupViews(ctx.db);
    await refreshDedupViews(ctx.db);
  });

  describe("per-category device accuracy priority", () => {
    it("v_daily_metrics uses recovery priority for HR/HRV and activity priority for steps", async () => {
      // Both providers have values for ALL fields — tests that per-category priority picks different winners
      await ctx.db.insert(dailyMetrics).values([
        {
          date: "2026-03-15",
          providerId: "whoop",
          restingHr: 52,
          hrv: 65.5,
          spo2Avg: 97.2,
          skinTempC: 33.7,
          steps: 5000, // WHOOP's step estimate (less accurate, uses wrist accelerometer)
          activeEnergyKcal: 380,
          distanceKm: 4.2,
        },
        {
          date: "2026-03-15",
          providerId: "apple_health",
          restingHr: 54,
          hrv: 62.0,
          spo2Avg: 96.8,
          skinTempC: null,
          steps: 8421, // Apple Watch step count (more accurate all-day tracking)
          activeEnergyKcal: 450,
          distanceKm: 6.8,
        },
      ]);

      await refreshDedupViews(ctx.db);

      const rows = await ctx.db.execute<DailyMetricsViewRow>(
        sql`SELECT * FROM fitness.v_daily_metrics WHERE date = '2026-03-15'`,
      );

      expect(rows.length).toBe(1);
      const day = rows[0];
      expect(day).toBeDefined();
      // Recovery metrics: WHOOP should win (better 24/7 HR/HRV monitoring)
      expect(day?.resting_hr).toBe(52);
      expect(Number(day?.hrv)).toBeCloseTo(65.5);
      expect(Number(day?.spo2_avg)).toBeCloseTo(97.2);
      expect(Number(day?.skin_temp_c)).toBeCloseTo(33.7);
      // Daily activity metrics: Apple Health should win (better step/activity tracking)
      expect(day?.steps).toBe(8421);
      expect(Number(day?.active_energy_kcal)).toBeCloseTo(450);
      expect(Number(day?.distance_km)).toBeCloseTo(6.8);
    });

    it("v_sleep uses sleep-specific priority: Oura wins over WHOOP", async () => {
      await ensureProvider(ctx.db, "oura", "Oura");

      await ctx.db.insert(sleepSession).values([
        {
          providerId: "whoop",
          externalId: "whoop-sleep-cat-prio",
          startedAt: new Date("2026-03-15T23:00:00Z"),
          endedAt: new Date("2026-03-16T06:30:00Z"),
          durationMinutes: 420,
          deepMinutes: 110,
          remMinutes: 80,
          lightMinutes: 200,
          awakeMinutes: 30,
          efficiencyPct: 89.5,
          sleepType: "sleep",
        },
        {
          providerId: "oura",
          externalId: "oura-sleep-cat-prio",
          startedAt: new Date("2026-03-15T23:05:00Z"),
          endedAt: new Date("2026-03-16T06:25:00Z"),
          durationMinutes: 415,
          deepMinutes: 125,
          remMinutes: 95,
          lightMinutes: 170,
          awakeMinutes: 25,
          efficiencyPct: 92.1,
          sleepType: "sleep",
        },
      ]);

      await refreshDedupViews(ctx.db);

      const rows = await ctx.db.execute<SleepViewRow>(
        sql`SELECT * FROM fitness.v_sleep WHERE started_at::date = '2026-03-15'`,
      );

      const mainSleep = rows.filter((r) => !r.is_nap);
      expect(mainSleep.length).toBe(1);
      // Oura should win over WHOOP for sleep (best sleep staging accuracy per research)
      expect(mainSleep[0]?.provider_id).toBe("oura");
      expect(mainSleep[0]?.deep_minutes).toBe(125);
      expect(mainSleep[0]?.rem_minutes).toBe(95);
      expect(mainSleep[0]?.source_providers).toContain("oura");
      expect(mainSleep[0]?.source_providers).toContain("whoop");
    });

    it("category priority falls back to generic priority when not set", async () => {
      // Provider without category-specific priorities should use generic priority
      await ensureProvider(ctx.db, "garmin", "Garmin");

      // Garmin has sleep_priority: 40, WHOOP has sleep_priority: 20
      // WHOOP wins because lower priority number = higher preference
      await ctx.db.insert(sleepSession).values([
        {
          providerId: "whoop",
          externalId: "whoop-sleep-fallback",
          startedAt: new Date("2026-03-20T23:00:00Z"),
          endedAt: new Date("2026-03-21T06:30:00Z"),
          durationMinutes: 420,
          deepMinutes: 110,
          sleepType: "sleep",
        },
        {
          providerId: "garmin",
          externalId: "garmin-sleep-fallback",
          startedAt: new Date("2026-03-20T23:05:00Z"),
          endedAt: new Date("2026-03-21T06:25:00Z"),
          durationMinutes: 415,
          deepMinutes: 100,
          sleepType: "sleep",
        },
      ]);

      await refreshDedupViews(ctx.db);

      const rows = await ctx.db.execute<SleepViewRow>(
        sql`SELECT * FROM fitness.v_sleep WHERE started_at::date = '2026-03-20'`,
      );

      const mainSleep = rows.filter((r) => !r.is_nap);
      expect(mainSleep.length).toBe(1);
      // WHOOP sleep_priority (20) < Garmin sleep_priority (40) → WHOOP wins
      expect(mainSleep[0]?.provider_id).toBe("whoop");
    });

    it("v_daily_metrics picks Apple Watch over iPhone for steps within apple_health", async () => {
      // Same date, same provider (apple_health), different source_name values.
      // Apple Watch has daily_activity_priority 15 (from provider-level config),
      // iPhone has daily_activity_priority 50 (from device_priority pattern).
      // The view should pick Apple Watch's step count.
      await ctx.db.insert(dailyMetrics).values([
        {
          date: "2026-03-18",
          providerId: "apple_health",
          sourceName: "Apple Watch",
          steps: 4200,
          activeEnergyKcal: 280,
          distanceKm: 3.1,
        },
        {
          date: "2026-03-18",
          providerId: "apple_health",
          sourceName: "iPhone",
          steps: 3800,
          activeEnergyKcal: 250,
          distanceKm: 2.9,
        },
      ]);

      await refreshDedupViews(ctx.db);

      const rows = await ctx.db.execute<DailyMetricsViewRow>(
        sql`SELECT * FROM fitness.v_daily_metrics WHERE date = '2026-03-18'`,
      );

      expect(rows.length).toBe(1);
      const day = rows[0];
      expect(day).toBeDefined();
      // Apple Watch (activity priority 15) beats iPhone (activity priority 50)
      expect(day?.steps).toBe(4200);
      expect(Number(day?.active_energy_kcal)).toBeCloseTo(280);
      expect(Number(day?.distance_km)).toBeCloseTo(3.1);
    });

    it("v_activity uses device priority: Apple Health + Wahoo TICKR beats WHOOP", async () => {
      // Apple Health with source_name="Wahoo TICKR" should get device priority (5)
      // which beats WHOOP's provider-level activity priority (30)
      await ctx.db.insert(activity).values([
        {
          providerId: "apple_health",
          externalId: "ah-tickr-run",
          activityType: "running",
          startedAt: new Date("2026-03-25T10:00:00Z"),
          endedAt: new Date("2026-03-25T11:00:00Z"),
          name: "TICKR Run",
          sourceName: "Wahoo TICKR X",
        },
        {
          providerId: "whoop",
          externalId: "whoop-run-dev",
          activityType: "running",
          startedAt: new Date("2026-03-25T10:00:30Z"),
          endedAt: new Date("2026-03-25T10:59:00Z"),
          name: null,
          sourceName: null,
        },
      ]);

      await refreshDedupViews(ctx.db);

      const rows = await ctx.db.execute<ActivityViewRow>(
        sql`SELECT * FROM fitness.v_activity WHERE started_at::date = '2026-03-25'`,
      );

      expect(rows.length).toBe(1);
      // Apple Health with "Wahoo TICKR%" device pattern (priority 5) beats WHOOP (priority 30)
      expect(rows[0]?.provider_id).toBe("apple_health");
      expect(rows[0]?.name).toBe("TICKR Run");
    });

    it("v_activity falls back to provider priority when no device match", async () => {
      // Apple Health without source_name should use provider-level priority (90)
      // which loses to WHOOP's provider-level priority (30)
      await ctx.db.insert(activity).values([
        {
          providerId: "apple_health",
          externalId: "ah-no-device-run",
          activityType: "running",
          startedAt: new Date("2026-03-26T10:00:00Z"),
          endedAt: new Date("2026-03-26T11:00:00Z"),
          name: "Unknown Run",
          sourceName: null,
        },
        {
          providerId: "whoop",
          externalId: "whoop-run-dev2",
          activityType: "running",
          startedAt: new Date("2026-03-26T10:00:30Z"),
          endedAt: new Date("2026-03-26T10:59:00Z"),
          name: "WHOOP Run",
          sourceName: null,
        },
      ]);

      await refreshDedupViews(ctx.db);

      const rows = await ctx.db.execute<ActivityViewRow>(
        sql`SELECT * FROM fitness.v_activity WHERE started_at::date = '2026-03-26'`,
      );

      expect(rows.length).toBe(1);
      // WHOOP (30) beats Apple Health (90) when no device match
      expect(rows[0]?.provider_id).toBe("whoop");
    });
  });

  describe("v_sleep efficiency derivation", () => {
    it("derives efficiency for Apple Health as (deep + rem + light) / duration", async () => {
      await ctx.db.insert(sleepSession).values({
        providerId: "apple_health",
        externalId: "ah-eff-derive",
        startedAt: new Date("2026-04-01T23:00:00Z"),
        endedAt: new Date("2026-04-02T07:00:00Z"),
        durationMinutes: 480,
        deepMinutes: 90,
        remMinutes: 90,
        lightMinutes: 120,
        awakeMinutes: 15,
        efficiencyPct: null,
        sleepType: "sleep",
      });

      await refreshDedupViews(ctx.db);

      const rows = await ctx.db.execute<SleepViewRow>(
        sql`SELECT * FROM fitness.v_sleep WHERE started_at::date = '2026-04-01'`,
      );

      const mainSleep = rows.filter((r) => !r.is_nap);
      expect(mainSleep.length).toBe(1);
      // (90 + 90 + 120) / 480 * 100 = 62.5
      expect(Number(mainSleep[0]?.efficiency_pct)).toBeCloseTo(62.5, 1);
    });

    it("derives efficiency for Eight Sleep as duration / (duration + awake)", async () => {
      await ensureProvider(ctx.db, "eight-sleep", "Eight Sleep");

      await ctx.db.insert(sleepSession).values({
        providerId: "eight-sleep",
        externalId: "es-eff-derive",
        startedAt: new Date("2026-04-02T23:00:00Z"),
        endedAt: new Date("2026-04-03T07:00:00Z"),
        durationMinutes: 420,
        deepMinutes: 100,
        remMinutes: 90,
        lightMinutes: 230,
        awakeMinutes: 60,
        efficiencyPct: null,
        sleepType: "sleep",
      });

      await refreshDedupViews(ctx.db);

      const rows = await ctx.db.execute<SleepViewRow>(
        sql`SELECT * FROM fitness.v_sleep WHERE started_at::date = '2026-04-02'`,
      );

      const mainSleep = rows.filter((r) => !r.is_nap);
      expect(mainSleep.length).toBe(1);
      // 420 / (420 + 60) * 100 = 87.5
      expect(Number(mainSleep[0]?.efficiency_pct)).toBeCloseTo(87.5, 1);
    });

    it("derives efficiency for Polar as duration / (duration + awake)", async () => {
      await ensureProvider(ctx.db, "polar", "Polar");

      await ctx.db.insert(sleepSession).values({
        providerId: "polar",
        externalId: "polar-eff-derive",
        startedAt: new Date("2026-04-03T23:00:00Z"),
        endedAt: new Date("2026-04-04T07:00:00Z"),
        durationMinutes: 360,
        deepMinutes: 100,
        remMinutes: 90,
        lightMinutes: 170,
        awakeMinutes: 40,
        efficiencyPct: null,
        sleepType: "sleep",
      });

      await refreshDedupViews(ctx.db);

      const rows = await ctx.db.execute<SleepViewRow>(
        sql`SELECT * FROM fitness.v_sleep WHERE started_at::date = '2026-04-03'`,
      );

      const mainSleep = rows.filter((r) => !r.is_nap);
      expect(mainSleep.length).toBe(1);
      // 360 / (360 + 40) * 100 = 90.0
      expect(Number(mainSleep[0]?.efficiency_pct)).toBeCloseTo(90.0, 1);
    });

    it("uses stored efficiency_pct when present (Whoop)", async () => {
      await ctx.db.insert(sleepSession).values({
        providerId: "whoop",
        externalId: "whoop-eff-stored",
        startedAt: new Date("2026-04-04T23:00:00Z"),
        endedAt: new Date("2026-04-05T06:30:00Z"),
        durationMinutes: 420,
        deepMinutes: 110,
        remMinutes: 80,
        lightMinutes: 200,
        awakeMinutes: 30,
        efficiencyPct: 93.2,
        sleepType: "sleep",
      });

      await refreshDedupViews(ctx.db);

      const rows = await ctx.db.execute<SleepViewRow>(
        sql`SELECT * FROM fitness.v_sleep WHERE started_at::date = '2026-04-04'`,
      );

      const mainSleep = rows.filter((r) => !r.is_nap);
      expect(mainSleep.length).toBe(1);
      // Stored value used as-is
      expect(Number(mainSleep[0]?.efficiency_pct)).toBeCloseTo(93.2, 1);
    });

    it("returns null efficiency when awake_minutes is null", async () => {
      await ctx.db.insert(sleepSession).values({
        providerId: "apple_health",
        externalId: "ah-eff-no-awake",
        startedAt: new Date("2026-04-05T23:00:00Z"),
        endedAt: new Date("2026-04-06T07:00:00Z"),
        durationMinutes: 480,
        deepMinutes: null,
        remMinutes: null,
        lightMinutes: null,
        awakeMinutes: null,
        efficiencyPct: null,
        sleepType: "sleep",
      });

      await refreshDedupViews(ctx.db);

      const rows = await ctx.db.execute<SleepViewRow>(
        sql`SELECT * FROM fitness.v_sleep WHERE started_at::date = '2026-04-05'`,
      );

      const mainSleep = rows.filter((r) => !r.is_nap);
      expect(mainSleep.length).toBe(1);
      expect(mainSleep[0]?.efficiency_pct).toBeNull();
    });
  });
});
