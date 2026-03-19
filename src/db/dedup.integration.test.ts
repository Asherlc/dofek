import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshDedupViews } from "./dedup.ts";
import { loadProviderPriorityConfig, syncProviderPriorities } from "./provider-priority.ts";
import { activity, bodyMeasurement, dailyMetrics, metricStream, sleepSession } from "./schema.ts";
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
  environmental_audio_exposure: number | string | null;
  headphone_audio_exposure: number | string | null;
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
    const m = rows[0];
    expect(m).toBeDefined();
    // Withings wins (priority 15)
    expect(m?.provider_id).toBe("withings");
    expect(m?.weight_kg).toBeCloseTo(75.2);
    // Body fat from Withings (Apple Health was null)
    expect(m?.body_fat_pct).toBeCloseTo(18.5);
    expect(m?.source_providers).toContain("withings");
    expect(m?.source_providers).toContain("apple_health");
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
    await ctx.db.insert(metricStream).values([
      {
        providerId: "wahoo",
        activityId: wahooActivity.id,
        recordedAt: new Date("2026-03-05T10:00:00Z"),
        heartRate: 140,
        power: 200,
      },
      {
        providerId: "wahoo",
        activityId: wahooActivity.id,
        recordedAt: new Date("2026-03-05T10:00:06Z"),
        heartRate: 145,
        power: 210,
      },
    ]);

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
    expect(summary?.sample_count).toBe(2);
    expect(summary?.hr_sample_count).toBe(2);
    expect(summary?.power_sample_count).toBe(2);
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
});
