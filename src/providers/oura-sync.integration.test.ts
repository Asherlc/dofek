import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activity, dailyMetrics, healthEvent, metricStream, sleepSession } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import type {
  OuraDailyActivity,
  OuraDailyCardiovascularAge,
  OuraDailyReadiness,
  OuraDailyResilience,
  OuraDailySpO2,
  OuraDailyStress,
  OuraEnhancedTag,
  OuraHeartRate,
  OuraRestModePeriod,
  OuraSession,
  OuraSleepDocument,
  OuraSleepTime,
  OuraTag,
  OuraVO2Max,
  OuraWorkout,
} from "./oura.ts";
import { OuraProvider } from "./oura.ts";

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

function fakeWorkout(): OuraWorkout {
  return {
    id: "workout-001",
    activity: "running",
    calories: 350,
    day: "2026-03-01",
    distance: 5000,
    end_datetime: "2026-03-01T08:30:00+00:00",
    intensity: "moderate",
    label: "Morning Run",
    source: "autodetected",
    start_datetime: "2026-03-01T08:00:00+00:00",
  };
}

function fakeHeartRate(): OuraHeartRate {
  return {
    bpm: 62,
    source: "rest",
    timestamp: "2026-03-01T03:00:00+00:00",
  };
}

function fakeSession(): OuraSession {
  return {
    id: "session-001",
    day: "2026-03-01",
    start_datetime: "2026-03-01T07:00:00+00:00",
    end_datetime: "2026-03-01T07:15:00+00:00",
    type: "meditation",
    mood: "good",
  };
}

function fakeDailyStress(): OuraDailyStress {
  return {
    id: "stress-001",
    day: "2026-03-01",
    stress_high: 3600,
    recovery_high: 7200,
    day_summary: "normal",
  };
}

function fakeDailyResilience(): OuraDailyResilience {
  return {
    id: "resilience-001",
    day: "2026-03-01",
    contributors: { sleep_recovery: 80, daytime_recovery: 75, stress: 70 },
    level: "solid",
  };
}

function fakeCardiovascularAge(): OuraDailyCardiovascularAge {
  return { day: "2026-03-01", vascular_age: 35 };
}

function fakeTag(): OuraTag {
  return {
    id: "tag-001",
    day: "2026-03-01",
    text: "Feeling stressed",
    timestamp: "2026-03-01T12:00:00+00:00",
    tags: ["tag_generic_stress"],
  };
}

function fakeEnhancedTag(): OuraEnhancedTag {
  return {
    id: "etag-001",
    tag_type_code: "caffeine",
    start_time: "2026-03-01T09:00:00+00:00",
    end_time: null,
    start_day: "2026-03-01",
    end_day: null,
    comment: "Morning coffee",
    custom_name: null,
  };
}

function fakeRestMode(): OuraRestModePeriod {
  return {
    id: "rest-001",
    start_day: "2026-03-01",
    start_time: "2026-03-01T20:00:00+00:00",
    end_day: "2026-03-02",
    end_time: "2026-03-02T08:00:00+00:00",
  };
}

function fakeSleepTime(): OuraSleepTime {
  return {
    id: "sleeptime-001",
    day: "2026-03-01",
    optimal_bedtime: { day_tz: -28800, end_offset: 82800, start_offset: 79200 },
    recommendation: "follow_optimal_bedtime",
    status: "optimal_found",
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

function fakeOuraActivity(): OuraDailyActivity {
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

function fakeStress(): OuraDailyStress {
  return {
    id: "stress-dm-001",
    day: "2026-03-01",
    stress_high: 5400, // 90 min
    recovery_high: 10800, // 180 min
    day_summary: "restored",
  };
}

function fakeResilience(): OuraDailyResilience {
  return {
    id: "resilience-dm-001",
    day: "2026-03-01",
    level: "solid",
    contributors: {
      sleep_recovery: 85,
      daytime_recovery: 72,
      stress: 68,
    },
  };
}

interface MockFetchOptions {
  sleepDocs?: OuraSleepDocument[];
  spo2Docs?: OuraDailySpO2[];
  vo2MaxDocs?: OuraVO2Max[];
  workoutDocs?: OuraWorkout[];
  heartRateDocs?: OuraHeartRate[];
  sessionDocs?: OuraSession[];
  stressDocs?: OuraDailyStress[];
  resilienceDocs?: OuraDailyResilience[];
  cvAgeDocs?: OuraDailyCardiovascularAge[];
  tagDocs?: OuraTag[];
  enhancedTagDocs?: OuraEnhancedTag[];
  restModeDocs?: OuraRestModePeriod[];
  sleepTimeDocs?: OuraSleepTime[];
  readinessDocs?: OuraDailyReadiness[];
  activityDocs?: OuraDailyActivity[];
}

function ouraHandlers(opts?: MockFetchOptions) {
  const o = opts ?? {};

  return [
    http.post("https://api.ouraring.com/oauth/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-oura-token",
        refresh_token: "new-oura-refresh",
        expires_in: 86400,
        token_type: "Bearer",
      });
    }),

    // Order matters: more specific paths before less specific ones
    http.get("https://api.ouraring.com/v2/usercollection/sleep_time", () => {
      return HttpResponse.json({ data: o.sleepTimeDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/sleep", () => {
      return HttpResponse.json({ data: o.sleepDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_readiness", () => {
      return HttpResponse.json({ data: o.readinessDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_activity", () => {
      return HttpResponse.json({ data: o.activityDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_spo2", () => {
      return HttpResponse.json({ data: o.spo2Docs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/vO2_max", () => {
      return HttpResponse.json({ data: o.vo2MaxDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/workout", () => {
      return HttpResponse.json({ data: o.workoutDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/heartrate", () => {
      return HttpResponse.json({ data: o.heartRateDocs ?? [] });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/session", () => {
      return HttpResponse.json({ data: o.sessionDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_stress", () => {
      return HttpResponse.json({ data: o.stressDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_resilience", () => {
      return HttpResponse.json({ data: o.resilienceDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_cardiovascular_age", () => {
      return HttpResponse.json({ data: o.cvAgeDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/enhanced_tag", () => {
      return HttpResponse.json({ data: o.enhancedTagDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/tag", () => {
      return HttpResponse.json({ data: o.tagDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/rest_mode_period", () => {
      return HttpResponse.json({ data: o.restModeDocs ?? [], next_token: null });
    }),
  ];
}

const server = setupServer();

describe("OuraProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.OURA_CLIENT_ID = "test-oura-client";
    process.env.OURA_CLIENT_SECRET = "test-oura-secret";
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: "error" });
    await ensureProvider(ctx.db, "oura", "Oura", "https://api.ouraring.com");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs all data types", async () => {
    await saveTokens(ctx.db, "oura", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "daily heartrate personal session spo2 workout tag",
    });

    const since = new Date("2026-03-01T00:00:00Z");

    server.use(
      ...ouraHandlers({
        sleepDocs: [
          fakeSleepDoc({ id: "sleep-001" }),
          fakeSleepDoc({ id: "sleep-nap-001", type: "rest", total_sleep_duration: 1500 }),
        ],
        spo2Docs: [fakeSpO2()],
        vo2MaxDocs: [fakeVO2Max()],
        workoutDocs: [fakeWorkout()],
        heartRateDocs: [fakeHeartRate()],
        sessionDocs: [fakeSession()],
        stressDocs: [fakeDailyStress()],
        resilienceDocs: [fakeDailyResilience()],
        cvAgeDocs: [fakeCardiovascularAge()],
        tagDocs: [fakeTag()],
        enhancedTagDocs: [fakeEnhancedTag()],
        restModeDocs: [fakeRestMode()],
        sleepTimeDocs: [fakeSleepTime()],
      }),
    );

    const provider = new OuraProvider();
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(10);

    // Verify sleep sessions
    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "oura"));
    expect(sleepRows).toHaveLength(2);
    const mainSleep = sleepRows.find((r) => r.externalId === "sleep-001");
    expect(mainSleep?.deepMinutes).toBe(90);
    expect(mainSleep?.sleepType).toBe("long_sleep");

    // Verify workouts → activity table
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "oura"));
    const workout = activityRows.find((r) => r.externalId === "workout-001");
    expect(workout).toBeDefined();
    expect(workout?.activityType).toBe("running");
    expect(workout?.name).toBe("Morning Run");

    // Verify sessions → activity table
    const session = activityRows.find((r) => r.externalId === "session-001");
    expect(session).toBeDefined();
    expect(session?.activityType).toBe("meditation");

    // Verify heart rate → metricStream
    const hrRows = await ctx.db
      .select()
      .from(metricStream)
      .where(eq(metricStream.providerId, "oura"));
    expect(hrRows.length).toBeGreaterThanOrEqual(1);
    expect(hrRows[0]?.heartRate).toBe(62);

    // Verify healthEvent entries
    const eventRows = await ctx.db
      .select()
      .from(healthEvent)
      .where(eq(healthEvent.providerId, "oura"));

    const stressEvent = eventRows.find((e) => e.type === "oura_daily_stress");
    expect(stressEvent).toBeDefined();
    expect(stressEvent?.value).toBe(3600);
    expect(stressEvent?.valueText).toBe("normal");

    const resilienceEvent = eventRows.find((e) => e.type === "oura_daily_resilience");
    expect(resilienceEvent).toBeDefined();
    expect(resilienceEvent?.valueText).toBe("solid");

    const cvAgeEvent = eventRows.find((e) => e.type === "oura_cardiovascular_age");
    expect(cvAgeEvent).toBeDefined();
    expect(cvAgeEvent?.value).toBe(35);

    const tagEvent = eventRows.find((e) => e.type === "oura_tag");
    expect(tagEvent).toBeDefined();
    expect(tagEvent?.valueText).toContain("tag_generic_stress");

    const enhancedTagEvent = eventRows.find((e) => e.type === "oura_enhanced_tag");
    expect(enhancedTagEvent).toBeDefined();
    expect(enhancedTagEvent?.valueText).toBe("caffeine");

    const restModeEvent = eventRows.find((e) => e.type === "oura_rest_mode");
    expect(restModeEvent).toBeDefined();

    const sleepTimeEvent = eventRows.find((e) => e.type === "oura_sleep_time");
    expect(sleepTimeEvent).toBeDefined();
    expect(sleepTimeEvent?.valueText).toBe("follow_optimal_bedtime");
  });

  it("syncs stress and resilience data into daily metrics", async () => {
    await saveTokens(ctx.db, "oura", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "daily heartrate personal session spo2 workout",
    });

    const since = new Date("2026-03-01T00:00:00Z");

    server.use(
      ...ouraHandlers({
        readinessDocs: [fakeReadiness()],
        activityDocs: [fakeOuraActivity()],
        stressDocs: [fakeStress()],
        resilienceDocs: [fakeResilience()],
      }),
    );

    const provider = new OuraProvider();
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
      scopes: "daily heartrate personal session spo2 workout tag",
    });

    const since = new Date("2026-03-01T00:00:00Z");

    server.use(
      ...ouraHandlers({
        sleepDocs: [fakeSleepDoc({ id: "sleep-001" })],
        workoutDocs: [fakeWorkout()],
        stressDocs: [fakeDailyStress()],
      }),
    );

    const provider = new OuraProvider();
    await provider.sync(ctx.db, since);
    await provider.sync(ctx.db, since);

    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "oura"));
    const countOf001 = sleepRows.filter((r) => r.externalId === "sleep-001").length;
    expect(countOf001).toBe(1);

    // Workout should also be upserted
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "workout-001"));
    expect(activityRows).toHaveLength(1);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "oura", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"),
      scopes: "daily heartrate personal session spo2 workout tag",
    });

    server.use(...ouraHandlers());

    const provider = new OuraProvider();
    await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "oura");
    expect(tokens?.accessToken).toBe("refreshed-oura-token");
  });

  it("returns error when no tokens exist", async () => {
    const { oauthToken } = await import("../db/schema.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "oura"));

    const provider = new OuraProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);
  });
});

// ============================================================
// Integration tests for sync() error paths
// ============================================================

function ouraErrorHandlers(opts: { sleepError?: boolean }) {
  return [
    // Token refresh
    http.post("https://api.ouraring.com/oauth/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-oura-token",
        refresh_token: "new-oura-refresh",
        expires_in: 86400,
        token_type: "Bearer",
      });
    }),

    // Sleep time (must come before sleep)
    http.get("https://api.ouraring.com/v2/usercollection/sleep_time", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),

    // Sleep — error or empty
    http.get("https://api.ouraring.com/v2/usercollection/sleep", () => {
      if (opts.sleepError) {
        return new HttpResponse("Rate Limited", { status: 429 });
      }
      return HttpResponse.json({ data: [], next_token: null });
    }),

    // All other endpoints — empty
    http.get("https://api.ouraring.com/v2/usercollection/daily_spo2", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_readiness", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_activity", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_stress", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_resilience", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_cardiovascular_age", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/vO2_max", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/workout", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/heartrate", () => {
      return HttpResponse.json({ data: [] });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/session", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/enhanced_tag", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/tag", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/rest_mode_period", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
  ];
}

describe("OuraProvider.sync() — error paths (integration)", () => {
  let ctx: TestContext;
  const errorServer = setupServer();

  beforeAll(async () => {
    process.env.OURA_CLIENT_ID = "test-oura-client";
    process.env.OURA_CLIENT_SECRET = "test-oura-secret";
    ctx = await setupTestDatabase();
    errorServer.listen({ onUnhandledRequest: "error" });
    await ensureProvider(ctx.db, "oura", "Oura", "https://api.ouraring.com");
  }, 60_000);

  afterEach(() => {
    errorServer.resetHandlers();
  });

  afterAll(async () => {
    errorServer.close();
    if (ctx) await ctx.cleanup();
  });

  it("captures sleep fetch errors", async () => {
    await saveTokens(ctx.db, "oura", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "daily heartrate personal session spo2",
    });

    const since = new Date();
    since.setDate(since.getDate() - 1);

    errorServer.use(...ouraErrorHandlers({ sleepError: true }));

    const provider = new OuraProvider();
    const result = await provider.sync(ctx.db, since);

    const sleepError = result.errors.find((e) => e.message.includes("sleep"));
    expect(sleepError).toBeDefined();
  });
});
