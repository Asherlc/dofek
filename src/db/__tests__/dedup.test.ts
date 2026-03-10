import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshDedupViews } from "../dedup.js";
import { activity, bodyMeasurement, dailyMetrics, metricStream, sleepSession } from "../schema.js";
import { ensureProvider } from "../tokens.js";
import { setupTestDatabase, type TestContext } from "./test-helpers.js";

describe("Deduplication materialized views", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    // Seed providers with priorities
    await ensureProvider(ctx.db, "wahoo", "Wahoo");
    await ensureProvider(ctx.db, "whoop", "WHOOP");
    await ensureProvider(ctx.db, "apple_health", "Apple Health");
    await ensureProvider(ctx.db, "withings", "Withings");
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
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

    const rows = await ctx.db.execute(sql`SELECT * FROM fitness.v_activity ORDER BY started_at`);

    // Should have 2 canonical activities: merged run + standalone yoga
    expect(rows.length).toBe(2);

    const run = rows.find((r: any) => r.activity_type === "running") as any;
    expect(run).toBeDefined();
    // Wahoo is highest priority (10), should be the primary
    expect(run.provider_id).toBe("wahoo");
    // Name should come from Wahoo (highest priority with non-null name)
    expect(run.name).toBe("Morning Run");
    // source_providers should include all 3
    expect(run.source_providers).toContain("wahoo");
    expect(run.source_providers).toContain("whoop");
    expect(run.source_providers).toContain("apple_health");
    // raw should be merged JSONB (wahoo fields win on conflict)
    const raw = typeof run.raw === "string" ? JSON.parse(run.raw) : run.raw;
    expect(raw.avgPower).toBe(220);
    expect(raw.strain).toBe(12.5); // from WHOOP, no conflict with wahoo

    const yoga = rows.find((r: any) => r.activity_type === "yoga") as any;
    expect(yoga).toBeDefined();
    expect(yoga.provider_id).toBe("whoop");
    expect(yoga.source_providers).toHaveLength(1);
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

    const rows = await ctx.db.execute(
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
        isNap: false,
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
        isNap: false,
      },
    ]);

    await refreshDedupViews(ctx.db);

    const rows = await ctx.db.execute(
      sql`SELECT * FROM fitness.v_sleep WHERE started_at::date >= '2026-03-01' AND started_at::date <= '2026-03-02'`,
    );

    // Should merge into 1 canonical sleep session
    const mainSleep = rows.filter((r: any) => !r.is_nap);
    expect(mainSleep.length).toBe(1);
    // WHOOP should win (priority 30 < apple_health 90)
    expect((mainSleep[0] as any).provider_id).toBe("whoop");
    expect((mainSleep[0] as any).deep_minutes).toBe(120);
    expect((mainSleep[0] as any).source_providers).toContain("whoop");
    expect((mainSleep[0] as any).source_providers).toContain("apple_health");
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

    const rows = await ctx.db.execute(
      sql`SELECT * FROM fitness.v_body_measurement WHERE recorded_at::date = '2026-03-01'`,
    );

    expect(rows.length).toBe(1);
    const m = rows[0] as any;
    // Withings wins (priority 15)
    expect(m.provider_id).toBe("withings");
    expect(m.weight_kg).toBeCloseTo(75.2);
    // Body fat from Withings (Apple Health was null)
    expect(m.body_fat_pct).toBeCloseTo(18.5);
    expect(m.source_providers).toContain("withings");
    expect(m.source_providers).toContain("apple_health");
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

    const rows = await ctx.db.execute(
      sql`SELECT * FROM fitness.v_daily_metrics WHERE date = '2026-03-01'`,
    );

    expect(rows.length).toBe(1);
    const day = rows[0] as any;
    // WHOOP wins for restingHr/hrv/spo2 (priority 30 < 90)
    expect(day.resting_hr).toBe(52);
    expect(Number(day.hrv)).toBeCloseTo(65.5);
    expect(Number(day.spo2_avg)).toBeCloseTo(97.2);
    expect(Number(day.skin_temp_c)).toBeCloseTo(33.7);
    // Apple Health wins for steps (WHOOP was null)
    expect(day.steps).toBe(8421);
    expect(Number(day.active_energy_kcal)).toBeCloseTo(450);
    expect(day.flights_climbed).toBe(12);
    // Both providers listed
    expect(day.source_providers).toContain("whoop");
    expect(day.source_providers).toContain("apple_health");
  });

  it("v_metric_stream uses primary provider from v_activity", async () => {
    // Create an activity with metric streams from two providers
    const [wahooActivity] = await ctx.db
      .insert(activity)
      .values({
        providerId: "wahoo",
        externalId: "wahoo-ride-ms",
        activityType: "cycling",
        startedAt: new Date("2026-03-05T10:00:00Z"),
        endedAt: new Date("2026-03-05T11:00:00Z"),
      })
      .returning({ id: activity.id });

    const [whoopActivity] = await ctx.db
      .insert(activity)
      .values({
        providerId: "whoop",
        externalId: "whoop-ride-ms",
        activityType: "cycling",
        startedAt: new Date("2026-03-05T10:00:00Z"),
        endedAt: new Date("2026-03-05T11:00:00Z"),
      })
      .returning({ id: activity.id });

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

    // WHOOP stream — HR only
    await ctx.db.insert(metricStream).values([
      {
        providerId: "whoop",
        activityId: whoopActivity.id,
        recordedAt: new Date("2026-03-05T10:00:00Z"),
        heartRate: 138,
      },
      {
        providerId: "whoop",
        activityId: whoopActivity.id,
        recordedAt: new Date("2026-03-05T10:00:06Z"),
        heartRate: 143,
      },
    ]);

    // Non-activity-linked WHOOP 24/7 HR (should pass through)
    await ctx.db.insert(metricStream).values({
      providerId: "whoop",
      activityId: null,
      recordedAt: new Date("2026-03-05T03:00:00Z"),
      heartRate: 55,
    });

    await refreshDedupViews(ctx.db);

    const rows = await ctx.db.execute(
      sql`SELECT * FROM fitness.v_metric_stream WHERE recorded_at::date = '2026-03-05' ORDER BY recorded_at`,
    );

    // Should have: 1 non-activity HR + 2 wahoo activity streams = 3
    // (WHOOP activity streams excluded because wahoo is primary)
    expect(rows.length).toBe(3);
    const activityStreams = rows.filter((r: any) => r.activity_id !== null);
    expect(activityStreams.length).toBe(2);
    // All activity streams should be from wahoo
    expect(activityStreams.every((r: any) => r.provider_id === "wahoo")).toBe(true);
    // Non-activity stream should pass through
    const bgStream = rows.find((r: any) => r.activity_id === null) as any;
    expect(bgStream.heart_rate).toBe(55);
  });

  it("refreshDedupViews can be called multiple times", async () => {
    // Should not error on second refresh (CONCURRENTLY)
    await refreshDedupViews(ctx.db);
    await refreshDedupViews(ctx.db);
  });
});
