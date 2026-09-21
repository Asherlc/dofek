import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activity, sleepSession } from "../db/schema/activity.ts";
import { healthEvent } from "../db/schema/clinical.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { OuraProvider } from "./oura/provider.ts";
import type {
  OuraDailyActivity,
  OuraDailySpO2,
  OuraEnhancedTag,
  OuraHeartRate,
  OuraRestModePeriod,
  OuraSession,
  OuraSleepDocument,
  OuraTag,
  OuraWorkout,
} from "./oura/schemas.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createCapturingMetricStreamPublisher } from "./test-helpers.ts";

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

interface MockFetchOptions {
  sleepDocs?: OuraSleepDocument[];
  spo2Docs?: OuraDailySpO2[];
  workoutDocs?: OuraWorkout[];
  heartRateDocs?: OuraHeartRate[];
  sessionDocs?: OuraSession[];
  tagDocs?: OuraTag[];
  enhancedTagDocs?: OuraEnhancedTag[];
  restModeDocs?: OuraRestModePeriod[];
  activityDocs?: OuraDailyActivity[];
}

function ouraHandlers(opts?: MockFetchOptions) {
  const options = opts ?? {};

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
    http.get("https://api.ouraring.com/v2/usercollection/sleep", () => {
      return HttpResponse.json({ data: options.sleepDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_activity", () => {
      return HttpResponse.json({ data: options.activityDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_spo2", () => {
      return HttpResponse.json({ data: options.spo2Docs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/workout", () => {
      return HttpResponse.json({ data: options.workoutDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/heartrate", () => {
      return HttpResponse.json({ data: options.heartRateDocs ?? [] });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/session", () => {
      return HttpResponse.json({ data: options.sessionDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/enhanced_tag", () => {
      return HttpResponse.json({ data: options.enhancedTagDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/tag", () => {
      return HttpResponse.json({ data: options.tagDocs ?? [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/rest_mode_period", () => {
      return HttpResponse.json({ data: options.restModeDocs ?? [], next_token: null });
    }),
  ];
}

const server = setupServer();
const metricStreamCapture = createCapturingMetricStreamPublisher();

describe("OuraProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.OURA_CLIENT_ID = "test-oura-client";
    process.env.OURA_CLIENT_SECRET = "test-oura-secret";
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, "oura", "Oura", "https://api.ouraring.com");
  }, 60_000);

  beforeEach(() => {
    metricStreamCapture.publishedMetricStreamRows.length = 0;
  });

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
        workoutDocs: [fakeWorkout()],
        heartRateDocs: [fakeHeartRate()],
        sessionDocs: [fakeSession()],
        tagDocs: [fakeTag()],
        enhancedTagDocs: [fakeEnhancedTag()],
        restModeDocs: [fakeRestMode()],
      }),
    );

    const provider = new OuraProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

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
    expect(workout?.canonicalType).toBe("running");
    expect(workout?.name).toBe("Morning Run");

    // Verify sessions → activity table
    const session = activityRows.find((r) => r.externalId === "session-001");
    expect(session).toBeDefined();
    expect(session?.canonicalType).toBe("meditation");

    // Verify heart rate metric stream events
    const hrRows = metricStreamCapture.publishedMetricStreamRows;
    const heartRateSamples = hrRows.filter((sample) => sample.channel === "heart_rate");
    expect(heartRateSamples.length).toBeGreaterThanOrEqual(1);
    expect(heartRateSamples[0]?.scalar).toBe(62);

    // Verify healthEvent entries
    const eventRows = await ctx.db
      .select()
      .from(healthEvent)
      .where(eq(healthEvent.providerId, "oura"));

    const tagEvent = eventRows.find((e) => e.type === "oura_tag");
    expect(tagEvent).toBeDefined();
    expect(tagEvent?.valueText).toContain("tag_generic_stress");

    const enhancedTagEvent = eventRows.find((e) => e.type === "oura_enhanced_tag");
    expect(enhancedTagEvent).toBeDefined();
    expect(enhancedTagEvent?.valueText).toBe("caffeine");

    const restModeEvent = eventRows.find((e) => e.type === "oura_rest_mode");
    expect(restModeEvent).toBeDefined();
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
      }),
    );

    const provider = new OuraProvider();
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

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
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "oura");
    expect(tokens?.accessToken).toBe("refreshed-oura-token");
  });

  it("returns error when no tokens exist", async () => {
    const { oauthToken } = await import("../db/schema/reference.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "oura"));

    const provider = new OuraProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

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
    errorServer.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    const sleepError = result.errors.find((e) => e.message.includes("sleep"));
    expect(sleepError).toBeDefined();
  });
});
