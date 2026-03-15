import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { dailyMetrics, sleepSession } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import type {
  OuraDailyActivity,
  OuraDailyReadiness,
  OuraDailyResilience,
  OuraDailySpO2,
  OuraDailyStress,
  OuraSleepDocument,
  OuraVO2Max,
  OuraWorkout,
} from "../oura.ts";
import { OuraProvider } from "../oura.ts";

function fakeSleepDoc(overrides: Partial<OuraSleepDocument> = {}): OuraSleepDocument {
  return {
    id: "sleep-001",
    day: "2026-03-01",
    bedtime_start: "2026-02-28T22:30:00+00:00",
    bedtime_end: "2026-03-01T06:45:00+00:00",
    total_sleep_duration: 28800,
    deep_sleep_duration: 5400,
    rem_sleep_duration: 5700,
    light_sleep_duration: 14400,
    awake_time: 3300,
    efficiency: 87,
    type: "long_sleep",
    average_heart_rate: 52,
    lowest_heart_rate: 45,
    average_hrv: 48,
    time_in_bed: 29700,
    readiness_score_delta: 2.5,
    latency: 900,
    ...overrides,
  };
}

function fakeReadiness(): OuraDailyReadiness {
  return {
    id: "readiness-001",
    day: "2026-03-01",
    score: 82,
    temperature_deviation: -0.15,
    temperature_trend_deviation: 0.05,
    contributors: {
      resting_heart_rate: 85,
      hrv_balance: 78,
      body_temperature: 90,
      recovery_index: 72,
      sleep_balance: 80,
      previous_night: 88,
      previous_day_activity: 75,
      activity_balance: 82,
    },
  };
}

function fakeActivity(): OuraDailyActivity {
  return {
    id: "activity-001",
    day: "2026-03-01",
    steps: 9500,
    active_calories: 450,
    equivalent_walking_distance: 8200,
    high_activity_time: 2700,
    medium_activity_time: 1800,
    low_activity_time: 7200,
    resting_time: 50400,
    sedentary_time: 28800,
    total_calories: 2300,
  };
}

function fakeSpO2(): OuraDailySpO2 {
  return {
    id: "spo2-001",
    day: "2026-03-01",
    spo2_percentage: { average: 97.5 },
    breathing_disturbance_index: 12,
  };
}

function fakeVO2Max(): OuraVO2Max {
  return {
    id: "vo2max-001",
    day: "2026-03-01",
    timestamp: "2026-03-01T08:00:00",
    vo2_max: 42.5,
  };
}

function fakeStress(): OuraDailyStress {
  return {
    id: "stress-001",
    day: "2026-03-01",
    stress_high: 5400, // 90 min
    recovery_high: 10800, // 180 min
    day_summary: "restored",
  };
}

function fakeResilience(): OuraDailyResilience {
  return {
    id: "resilience-001",
    day: "2026-03-01",
    level: "solid",
    contributors: {
      sleep_recovery: 85,
      daytime_recovery: 72,
      stress: 68,
    },
  };
}

function createMockFetch(opts?: {
  sleepDocs?: OuraSleepDocument[];
  readinessDocs?: OuraDailyReadiness[];
  activityDocs?: OuraDailyActivity[];
  spo2Docs?: OuraDailySpO2[];
  vo2MaxDocs?: OuraVO2Max[];
  workoutDocs?: OuraWorkout[];
  stressDocs?: OuraDailyStress[];
  resilienceDocs?: OuraDailyResilience[];
}): typeof globalThis.fetch {
  const sleepDocs = opts?.sleepDocs ?? [];
  const readinessDocs = opts?.readinessDocs ?? [];
  const activityDocs = opts?.activityDocs ?? [];
  const spo2Docs = opts?.spo2Docs ?? [];
  const vo2MaxDocs = opts?.vo2MaxDocs ?? [];
  const workoutDocs = opts?.workoutDocs ?? [];
  const stressDocs = opts?.stressDocs ?? [];
  const resilienceDocs = opts?.resilienceDocs ?? [];

  return (async (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = input.toString();

    // Token refresh
    if (urlStr.includes("/oauth/token")) {
      return Response.json({
        access_token: "refreshed-oura-token",
        refresh_token: "new-oura-refresh",
        expires_in: 86400,
        token_type: "Bearer",
      });
    }

    // Sleep
    if (urlStr.includes("/v2/usercollection/sleep")) {
      return Response.json({ data: sleepDocs, next_token: null });
    }

    // Daily readiness
    if (urlStr.includes("/v2/usercollection/daily_readiness")) {
      return Response.json({ data: readinessDocs, next_token: null });
    }

    // Daily activity
    if (urlStr.includes("/v2/usercollection/daily_activity")) {
      return Response.json({ data: activityDocs, next_token: null });
    }

    // Daily SpO2
    if (urlStr.includes("/v2/usercollection/daily_spo2")) {
      return Response.json({ data: spo2Docs, next_token: null });
    }

    // VO2 max
    if (urlStr.includes("/v2/usercollection/vO2_max")) {
      return Response.json({ data: vo2MaxDocs, next_token: null });
    }

    // Workouts
    if (urlStr.includes("/v2/usercollection/workout")) {
      return Response.json({ data: workoutDocs, next_token: null });
    }

    // Daily stress
    if (urlStr.includes("/v2/usercollection/daily_stress")) {
      return Response.json({ data: stressDocs, next_token: null });
    }

    // Daily resilience
    if (urlStr.includes("/v2/usercollection/daily_resilience")) {
      return Response.json({ data: resilienceDocs, next_token: null });
    }

    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("OuraProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.OURA_CLIENT_ID = "test-oura-client";
    process.env.OURA_CLIENT_SECRET = "test-oura-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "oura", "Oura", "https://api.ouraring.com");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("syncs sleep, readiness, and activity data", async () => {
    await saveTokens(ctx.db, "oura", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "daily heartrate personal session spo2",
    });

    const since = new Date("2026-03-01T00:00:00Z");
    const provider = new OuraProvider(
      createMockFetch({
        sleepDocs: [
          fakeSleepDoc({ id: "sleep-001" }),
          fakeSleepDoc({ id: "sleep-nap-001", type: "rest", total_sleep_duration: 1500 }),
        ],
        readinessDocs: [fakeReadiness()],
        activityDocs: [fakeActivity()],
        spo2Docs: [fakeSpO2()],
        vo2MaxDocs: [fakeVO2Max()],
      }),
    );

    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);

    // Verify sleep sessions
    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "oura"));
    expect(sleepRows).toHaveLength(2);

    const mainSleep = sleepRows.find((r) => r.externalId === "sleep-001");
    if (!mainSleep) throw new Error("expected sleep-001");
    expect(mainSleep.deepMinutes).toBe(90);
    expect(mainSleep.remMinutes).toBe(95);
    expect(mainSleep.efficiencyPct).toBe(87);
    expect(mainSleep.isNap).toBe(false);

    const nap = sleepRows.find((r) => r.externalId === "sleep-nap-001");
    if (!nap) throw new Error("expected sleep-nap-001");
    expect(nap.isNap).toBe(true);

    // Verify daily metrics including SpO2 and VO2 max
    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "oura"));
    expect(dailyRows).toHaveLength(1);

    const daily = dailyRows[0];
    if (!daily) throw new Error("expected daily metrics");
    expect(daily.steps).toBe(9500);
    expect(daily.restingHr).toBe(85);
    expect(daily.hrv).toBe(78);
    expect(daily.activeEnergyKcal).toBe(450);
    expect(daily.exerciseMinutes).toBe(75);
    expect(daily.skinTempC).toBeCloseTo(-0.15);
    expect(daily.spo2Avg).toBeCloseTo(97.5);
    expect(daily.vo2max).toBeCloseTo(42.5);
  });

  it("syncs stress and resilience data into daily metrics", async () => {
    await saveTokens(ctx.db, "oura", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "daily heartrate personal session spo2 workout",
    });

    const since = new Date("2026-03-01T00:00:00Z");
    const provider = new OuraProvider(
      createMockFetch({
        readinessDocs: [fakeReadiness()],
        activityDocs: [fakeActivity()],
        stressDocs: [fakeStress()],
        resilienceDocs: [fakeResilience()],
      }),
    );

    const result = await provider.sync(ctx.db, since);

    expect(result.errors).toHaveLength(0);

    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "oura"));

    const daily = dailyRows.find((r) => r.date === "2026-03-01");
    if (!daily) throw new Error("expected daily metrics for 2026-03-01");
    expect(daily.stressHighMinutes).toBe(90);
    expect(daily.recoveryHighMinutes).toBe(180);
    expect(daily.resilienceLevel).toBe("solid");
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "oura", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "daily heartrate personal session spo2",
    });

    const since = new Date("2026-03-01T00:00:00Z");
    const provider = new OuraProvider(
      createMockFetch({
        sleepDocs: [fakeSleepDoc({ id: "sleep-001" })],
        readinessDocs: [fakeReadiness()],
        activityDocs: [fakeActivity()],
      }),
    );

    await provider.sync(ctx.db, since);
    await provider.sync(ctx.db, since);

    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "oura"));
    const countOf001 = sleepRows.filter((r) => r.externalId === "sleep-001").length;
    expect(countOf001).toBe(1);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "oura", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"),
      scopes: "daily heartrate personal session spo2",
    });

    const provider = new OuraProvider(createMockFetch());
    await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    const { loadTokens } = await import("../../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "oura");
    expect(tokens?.accessToken).toBe("refreshed-oura-token");
  });

  it("returns error when no tokens exist", async () => {
    const { oauthToken } = await import("../../db/schema.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "oura"));

    const provider = new OuraProvider(createMockFetch());
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);
  });
});
