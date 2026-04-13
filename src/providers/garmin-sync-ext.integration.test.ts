import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activity,
  dailyMetrics,
  metricStream,
  oauthToken,
  sleepSession,
  userSettings,
} from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { GarminProvider } from "./garmin.ts";

// ============================================================
// Internal API token helpers
// ============================================================

const INTERNAL_SCOPE_MARKER = "garmin-connect-internal";

/** Build a serialized internal token set (as stored in DB) */
function makeInternalTokenSet(overrides: { expiresAt?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = overrides.expiresAt ?? now + 3600;

  const garminTokens = {
    oauth1: {
      oauth_token: "test-oauth1-token",
      oauth_token_secret: "test-oauth1-secret",
    },
    oauth2: {
      scope: "CONNECT_READ CONNECT_WRITE",
      jti: "test-jti",
      token_type: "Bearer",
      access_token: "test-internal-access-token",
      refresh_token: "test-internal-refresh-token",
      expires_in: 3600,
      expires_at: expiresAt,
      refresh_token_expires_in: 7776000,
      refresh_token_expires_at: now + 7776000,
    },
  };

  return {
    accessToken: JSON.stringify(garminTokens),
    refreshToken: null,
    expiresAt: new Date(expiresAt * 1000),
    scopes: INTERNAL_SCOPE_MARKER,
  };
}

// ============================================================
// Fake Connect API response builders
// ============================================================

function fakeConnectActivity(overrides: Record<string, unknown> = {}) {
  return {
    activityId: 50001,
    activityName: "Morning Run",
    activityType: { typeId: 1, typeKey: "running" },
    startTimeGMT: "2026-03-01 10:00:00",
    startTimeLocal: "2026-03-01 05:00:00",
    distance: 10500,
    duration: 3600000, // ms
    averageHR: 155,
    maxHR: 178,
    averageRunningCadenceInStepsPerMin: 172,
    calories: 720,
    elevationGain: 85,
    ...overrides,
  };
}

function fakeConnectSleepData(date: string) {
  return {
    dailySleepDTO: {
      id: 12345,
      userProfilePK: 1,
      calendarDate: date,
      sleepTimeSeconds: 28800,
      sleepStartTimestampGMT: 1772074800000, // epoch ms
      sleepEndTimestampGMT: 1772103600000,
      deepSleepSeconds: 5400,
      lightSleepSeconds: 12600,
      remSleepSeconds: 6300,
      awakeSleepSeconds: 4500,
      awakeningCount: 3,
      averageSpO2Value: 96.5,
      averageRespirationValue: 15.2,
      sleepScores: {
        overall: { value: 82, qualifierKey: "GOOD" },
      },
    },
  };
}

function fakeConnectDailySummary(date: string) {
  return {
    calendarDate: date,
    totalSteps: 12500,
    totalDistanceMeters: 9800,
    activeKilocalories: 920,
    bmrKilocalories: 1750,
    restingHeartRate: 55,
    averageSpo2: 97,
    floorsAscended: 14,
    moderateIntensityMinutes: 30,
    vigorousIntensityMinutes: 40,
    privacyProtected: false,
  };
}

function fakeHrvSummary(date: string) {
  return {
    calendarDate: date,
    weeklyAvg: 42,
    lastNight: 38,
    lastNightAvg: 40,
    lastNight5MinHigh: 55,
    status: "BALANCED",
    baseline: {
      lowUpper: 28,
      balancedLow: 35,
      balancedUpper: 55,
    },
  };
}

function fakeTrainingStatus() {
  return {
    userId: 1,
    acuteTrainingLoad: 350,
    chronicTrainingLoad: 400,
    trainingLoadBalance: -50,
    trainingLoadRatio: 0.875,
    latestRunVo2Max: 52.3,
    latestCycleVo2Max: 48.1,
    latestFitnessAge: 28,
    trainingStatusMessage: "PRODUCTIVE",
  };
}

function fakeStressData(date: string) {
  return {
    calendarDate: date,
    avgStressLevel: 35,
    maxStressLevel: 78,
    stressValuesArray: [
      [1772074800000, 25],
      [1772078400000, 42],
      [1772082000000, -1], // rest state, should be filtered
      [1772085600000, 55],
    ] satisfies Array<[number, number]>,
  };
}

function fakeHeartRateData(date: string) {
  return {
    userProfilePK: 1,
    calendarDate: date,
    startTimestampGMT: "2026-03-01T00:00:00.0",
    endTimestampGMT: "2026-03-01T23:59:59.0",
    startTimestampLocal: "2026-03-01T00:00:00.0",
    endTimestampLocal: "2026-03-01T23:59:59.0",
    maxHeartRate: 178,
    minHeartRate: 48,
    restingHeartRate: 55,
    lastSevenDaysAvgRestingHeartRate: 54,
    heartRateValues: [
      [1772074800000, 55],
      [1772078400000, 62],
      [1772082000000, null], // null value, should be filtered
      [1772085600000, 145],
    ] satisfies Array<[number, number | null]>,
  };
}

function fakeActivityDetail(activityId: number) {
  return {
    activityId,
    measurementCount: 2,
    metricsCount: 4,
    metricDescriptors: [
      { metricsIndex: 0, key: "directTimestamp" },
      { metricsIndex: 1, key: "directHeartRate" },
      { metricsIndex: 2, key: "directSpeed" },
      { metricsIndex: 3, key: "directElevation" },
    ],
    activityDetailMetrics: [
      { metrics: [1772110800000, 140, 2.5, 100] },
      { metrics: [1772110860000, 155, 3.0, 105] },
    ],
  };
}

// ============================================================
// Mock fetch for internal Connect API
// ============================================================

interface ConnectMockOptions {
  activities?: ReturnType<typeof fakeConnectActivity>[];
  sleepDates?: string[];
  dailyDates?: string[];
  stressDates?: string[];
  heartRateDates?: string[];
  activityDetailError?: boolean;
  sleepError?: boolean;
  dailySummaryPrivacyProtected?: boolean;
  hrvError?: boolean;
  trainingStatusError?: boolean;
  oauthConsumerError?: boolean;
  profileError?: boolean;
  tokenExchangeError?: boolean;
}

function createConnectMockFetch(opts: ConnectMockOptions = {}): typeof globalThis.fetch {
  const activities = opts.activities ?? [];

  return async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const urlStr = input.toString();

    // OAuth consumer credentials
    if (urlStr.includes("oauth_consumer.json")) {
      if (opts.oauthConsumerError) {
        return new Response("Not found", { status: 404 });
      }
      return Response.json({
        consumer_key: "test-consumer-key",
        consumer_secret: "test-consumer-secret",
      });
    }

    // OAuth1→OAuth2 exchange
    if (urlStr.includes("oauth-service/oauth/exchange")) {
      if (opts.tokenExchangeError) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json({
        scope: "CONNECT_READ CONNECT_WRITE",
        jti: "refreshed-jti",
        token_type: "Bearer",
        access_token: "refreshed-internal-token",
        refresh_token: "refreshed-internal-refresh",
        expires_in: 3600,
        refresh_token_expires_in: 7776000,
      });
    }

    // User profile (required by fromTokens)
    if (urlStr.includes("/userprofile-service/socialProfile")) {
      if (opts.profileError) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json({
        displayName: "testuser",
        userName: "testuser",
      });
    }

    // Activity list
    if (urlStr.includes("/activitylist-service/activities/search/activities")) {
      return Response.json(activities);
    }

    // Activity detail
    if (urlStr.includes("/activity-service/activity/") && urlStr.includes("/details")) {
      if (opts.activityDetailError) {
        return new Response("Internal Server Error", { status: 500 });
      }
      const idMatch = urlStr.match(/\/activity\/(\d+)\/details/);
      const activityId = Number(idMatch?.[1] ?? 0);
      return Response.json(fakeActivityDetail(activityId));
    }

    // Sleep
    if (urlStr.includes("/wellness-service/wellness/dailySleepData/")) {
      if (opts.sleepError) {
        return new Response("Internal Server Error", { status: 500 });
      }
      const dateMatch = urlStr.match(/date=(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch?.[1] ?? "2026-03-01";
      if (opts.sleepDates?.includes(date)) {
        return Response.json(fakeConnectSleepData(date));
      }
      // No sleep data — return missing timestamps so parseConnectSleep returns null
      return Response.json({
        dailySleepDTO: {
          id: 0,
          userProfilePK: 1,
          calendarDate: date,
        },
      });
    }

    // Daily summary
    if (urlStr.includes("/usersummary-service/usersummary/daily/")) {
      const dateMatch = urlStr.match(/calendarDate=(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch?.[1] ?? "2026-03-01";
      if (opts.dailySummaryPrivacyProtected) {
        return Response.json({
          ...fakeConnectDailySummary(date),
          privacyProtected: true,
        });
      }
      if (opts.dailyDates?.includes(date)) {
        return Response.json(fakeConnectDailySummary(date));
      }
      return Response.json(fakeConnectDailySummary(date));
    }

    // HRV
    if (urlStr.includes("/hrv-service/hrv/")) {
      if (opts.hrvError) {
        return new Response("Internal Server Error", { status: 500 });
      }
      const dateMatch = urlStr.match(/\/hrv\/(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch?.[1] ?? "2026-03-01";
      return Response.json(fakeHrvSummary(date));
    }

    // Training status
    if (urlStr.includes("/metrics-service/metrics/trainingstatus/")) {
      if (opts.trainingStatusError) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return Response.json(fakeTrainingStatus());
    }

    // Stress
    if (urlStr.includes("/wellness-service/wellness/dailyStress/")) {
      const dateMatch = urlStr.match(/dailyStress\/(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch?.[1] ?? "2026-03-01";
      if (opts.stressDates?.includes(date)) {
        return Response.json(fakeStressData(date));
      }
      // No stress data
      return Response.json({
        calendarDate: date,
        avgStressLevel: 0,
        maxStressLevel: 0,
        stressValuesArray: [],
      });
    }

    // Heart rate
    if (urlStr.includes("/wellness-service/wellness/dailyHeartRate/")) {
      const dateMatch = urlStr.match(/date=(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch?.[1] ?? "2026-03-01";
      if (opts.heartRateDates?.includes(date)) {
        return Response.json(fakeHeartRateData(date));
      }
      // No HR data
      return Response.json({
        userProfilePK: 1,
        calendarDate: date,
        startTimestampGMT: "",
        endTimestampGMT: "",
        startTimestampLocal: "",
        endTimestampLocal: "",
        maxHeartRate: 0,
        minHeartRate: 0,
        restingHeartRate: 0,
        lastSevenDaysAvgRestingHeartRate: 0,
        heartRateValues: [],
      });
    }

    return new Response("Not found", { status: 404 });
  };
}

// ============================================================
// Tests — Internal Connect API mode (new code paths only)
// ============================================================

describe("GarminProvider.sync() internal Connect API (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "garmin", "Garmin Connect");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("syncs activities via Connect internal API with detail streams", async () => {
    await saveTokens(ctx.db, "garmin", makeInternalTokenSet());

    const activities = [
      fakeConnectActivity({ activityId: 50001 }),
      fakeConnectActivity({
        activityId: 50002,
        activityName: "Afternoon Ride",
        activityType: { typeId: 2, typeKey: "cycling" },
        startTimeGMT: "2026-03-01 14:00:00",
      }),
    ];

    const provider = new GarminProvider(
      createConnectMockFetch({
        activities,
        sleepDates: [],
        stressDates: [],
        heartRateDates: [],
      }),
    );

    const since = new Date("2026-03-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("garmin");

    // Verify activities were inserted
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "garmin"));
    expect(activityRows.length).toBeGreaterThanOrEqual(2);

    const run = activityRows.find((r) => r.externalId === "50001");
    if (!run) throw new Error("expected activity 50001");
    expect(run.activityType).toBe("running");
    expect(run.name).toBe("Morning Run");

    const ride = activityRows.find((r) => r.externalId === "50002");
    if (!ride) throw new Error("expected activity 50002");
    expect(ride.activityType).toBe("cycling");

    // Verify metric_stream rows from activity detail
    const metrics = await ctx.db
      .select()
      .from(metricStream)
      .where(eq(metricStream.providerId, "garmin"));
    // 2 activities x 2 samples each = 4 heart-rate samples from activity detail
    const activityMetrics = metrics.filter((sample) => {
      return sample.activityId !== null && sample.channel === "heart_rate";
    });
    expect(activityMetrics.length).toBeGreaterThanOrEqual(4);
  });

  it("syncs sleep via Connect internal API day-by-day", async () => {
    await saveTokens(ctx.db, "garmin", makeInternalTokenSet());

    // Clear existing sleep and sync cursor so date range starts from `since`
    await ctx.db.delete(sleepSession).where(eq(sleepSession.providerId, "garmin"));
    await ctx.db.delete(userSettings).where(eq(userSettings.key, "garmin_sync_cursor"));

    const provider = new GarminProvider(
      createConnectMockFetch({
        activities: [],
        sleepDates: ["2026-03-01"],
        stressDates: [],
        heartRateDates: [],
      }),
    );

    // Narrow range: just March 1
    const since = new Date("2026-03-01T00:00:00Z");
    await provider.sync(ctx.db, since);

    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "garmin"));

    // Should have at least one sleep record
    expect(sleepRows.length).toBeGreaterThanOrEqual(1);

    const sleepRecord = sleepRows.find((r) => r.externalId === "12345");
    if (!sleepRecord) throw new Error("expected sleep session 12345");
    expect(sleepRecord.durationMinutes).toBe(480); // 28800 / 60
    expect(sleepRecord.deepMinutes).toBe(90);
    expect(sleepRecord.lightMinutes).toBe(210);
    expect(sleepRecord.remMinutes).toBe(105);
    expect(sleepRecord.awakeMinutes).toBe(75);
  });

  it("syncs daily metrics with HRV and training status enrichment", async () => {
    await saveTokens(ctx.db, "garmin", makeInternalTokenSet());

    // Clear existing daily metrics and sync cursor so date range starts from `since`
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "garmin"));
    await ctx.db.delete(userSettings).where(eq(userSettings.key, "garmin_sync_cursor"));

    const provider = new GarminProvider(
      createConnectMockFetch({
        activities: [],
        sleepDates: [],
        dailyDates: ["2026-03-01"],
        stressDates: [],
        heartRateDates: [],
      }),
    );

    const since = new Date("2026-03-01T00:00:00Z");
    await provider.sync(ctx.db, since);

    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "garmin"));

    expect(dailyRows.length).toBeGreaterThanOrEqual(1);

    const march1 = dailyRows.find((r) => r.date === "2026-03-01");
    if (!march1) throw new Error("expected daily metrics for 2026-03-01");
    expect(march1.steps).toBe(12500);
    expect(march1.restingHr).toBe(55);
    expect(march1.flightsClimbed).toBe(14);
    expect(march1.exerciseMinutes).toBe(70); // 30 + 40

    // HRV enrichment
    expect(march1.hrv).toBeCloseTo(40); // lastNightAvg from fakeHrvSummary

    // VO2max from training status
    expect(march1.vo2max).toBeCloseTo(52.3); // latestRunVo2Max
  });

  it("syncs daily metrics without HRV when HRV endpoint fails", async () => {
    await saveTokens(ctx.db, "garmin", makeInternalTokenSet());
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "garmin"));
    await ctx.db.delete(userSettings).where(eq(userSettings.key, "garmin_sync_cursor"));

    const provider = new GarminProvider(
      createConnectMockFetch({
        activities: [],
        sleepDates: [],
        stressDates: [],
        heartRateDates: [],
        hrvError: true,
        trainingStatusError: true,
      }),
    );

    const since = new Date("2026-03-01T00:00:00Z");
    await provider.sync(ctx.db, since);

    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "garmin"));

    // Daily metrics still synced even without HRV/training
    expect(dailyRows.length).toBeGreaterThanOrEqual(1);
    const march1 = dailyRows.find((r) => r.date === "2026-03-01");
    if (!march1) throw new Error("expected daily metrics");
    expect(march1.steps).toBe(12500);
    // HRV and VO2max should be undefined when endpoints fail
    expect(march1.hrv).toBeNull();
    expect(march1.vo2max).toBeNull();
  });

  it("syncs stress time-series into metric_stream", async () => {
    await saveTokens(ctx.db, "garmin", makeInternalTokenSet());

    // Clear metric streams and sync cursor so date range starts from `since`
    await ctx.db.delete(metricStream).where(eq(metricStream.providerId, "garmin"));
    await ctx.db.delete(userSettings).where(eq(userSettings.key, "garmin_sync_cursor"));

    const provider = new GarminProvider(
      createConnectMockFetch({
        activities: [],
        sleepDates: [],
        stressDates: ["2026-03-01"],
        heartRateDates: [],
      }),
    );

    const since = new Date("2026-03-01T00:00:00Z");
    await provider.sync(ctx.db, since);

    const stressMetrics = await ctx.db
      .select()
      .from(metricStream)
      .where(eq(metricStream.providerId, "garmin"));

    // fakeStressData has 4 entries, but -1 is filtered → 3 valid stress samples
    const stressSamples = stressMetrics.filter((sample) => sample.channel === "stress");
    expect(stressSamples.length).toBeGreaterThanOrEqual(3);
  });

  it("syncs heart rate time-series into metric_stream", async () => {
    await saveTokens(ctx.db, "garmin", makeInternalTokenSet());
    await ctx.db.delete(metricStream).where(eq(metricStream.providerId, "garmin"));
    await ctx.db.delete(userSettings).where(eq(userSettings.key, "garmin_sync_cursor"));

    const provider = new GarminProvider(
      createConnectMockFetch({
        activities: [],
        sleepDates: [],
        stressDates: [],
        heartRateDates: ["2026-03-01"],
      }),
    );

    const since = new Date("2026-03-01T00:00:00Z");
    await provider.sync(ctx.db, since);

    const hrMetrics = await ctx.db
      .select()
      .from(metricStream)
      .where(eq(metricStream.providerId, "garmin"));

    // fakeHeartRateData has 4 entries, null filtered → 3 valid HR samples
    const hrSamples = hrMetrics.filter((sample) => sample.channel === "heart_rate");
    expect(hrSamples.length).toBeGreaterThanOrEqual(3);
  });

  it("refreshes internal tokens via OAuth1→OAuth2 exchange when expired", async () => {
    const expiredTokenSet = makeInternalTokenSet({
      expiresAt: Math.floor(Date.now() / 1000) - 3600, // expired 1h ago
    });
    await saveTokens(ctx.db, "garmin", expiredTokenSet);

    const provider = new GarminProvider(
      createConnectMockFetch({
        activities: [],
        sleepDates: [],
        stressDates: [],
        heartRateDates: [],
      }),
    );

    const result = await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    // Should not have auth errors — tokens refreshed via exchange
    const authErrors = result.errors.filter(
      (e) => e.message.includes("authentication") || e.message.includes("expired"),
    );
    expect(authErrors).toHaveLength(0);

    // Verify refreshed tokens were saved
    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "garmin");
    expect(tokens).not.toBeNull();
    // The tokens should have been updated (the accessToken JSON contains refreshed oauth2)
    expect(tokens?.scopes).toBe(INTERNAL_SCOPE_MARKER);
  });

  it("saves sync cursor after successful sync", async () => {
    await saveTokens(ctx.db, "garmin", makeInternalTokenSet());

    // Clear cursor
    await ctx.db.delete(userSettings).where(eq(userSettings.key, "garmin_sync_cursor"));

    const provider = new GarminProvider(
      createConnectMockFetch({
        activities: [],
        sleepDates: [],
        stressDates: [],
        heartRateDates: [],
      }),
    );

    await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    // Verify cursor was saved
    const cursorRows = await ctx.db
      .select()
      .from(userSettings)
      .where(eq(userSettings.key, "garmin_sync_cursor"));
    expect(cursorRows).toHaveLength(1);
    const rawValue: unknown = cursorRows[0]?.value;
    expect(rawValue).toBeDefined();
    // Narrow the unknown JSONB value to access the cursor property
    if (rawValue !== null && typeof rawValue === "object" && "cursor" in rawValue) {
      const cursor = rawValue.cursor;
      expect(cursor).toBeDefined();
      const cursorStr = typeof cursor === "string" ? cursor : "";
      const cursorDate = new Date(cursorStr);
      expect(cursorDate.getTime()).toBeGreaterThan(Date.now() - 60_000);
    } else {
      expect.fail("Expected cursor value to be an object with cursor property");
    }
  });

  it("returns error when Connect API authentication fails", async () => {
    await saveTokens(ctx.db, "garmin", makeInternalTokenSet());

    const provider = new GarminProvider(
      createConnectMockFetch({
        oauthConsumerError: true,
      }),
    );

    const result = await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    // Should have a Connect API authentication error
    const authErrors = result.errors.filter((e) =>
      e.message.includes("Connect API authentication failed"),
    );
    expect(authErrors.length).toBeGreaterThanOrEqual(1);
  });

  it("continues syncing activity when detail stream fetch fails", async () => {
    await saveTokens(ctx.db, "garmin", makeInternalTokenSet());

    // Clear existing activities
    await ctx.db.delete(metricStream).where(eq(metricStream.providerId, "garmin"));
    await ctx.db.delete(activity).where(eq(activity.providerId, "garmin"));

    const provider = new GarminProvider(
      createConnectMockFetch({
        activities: [fakeConnectActivity({ activityId: 60001 })],
        activityDetailError: true,
        sleepDates: [],
        stressDates: [],
        heartRateDates: [],
      }),
    );

    const since = new Date("2026-03-01T00:00:00Z");
    await provider.sync(ctx.db, since);

    // Activity should still be inserted even if detail fails
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "60001"));
    expect(activityRows).toHaveLength(1);

    // No metric_stream rows for this activity (detail failed)
    const metrics = await ctx.db
      .select()
      .from(metricStream)
      .where(eq(metricStream.activityId, activityRows[0]?.id ?? ""));
    expect(metrics).toHaveLength(0);
  });

  it("skips privacy-protected daily summaries", async () => {
    await saveTokens(ctx.db, "garmin", makeInternalTokenSet());
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "garmin"));

    const provider = new GarminProvider(
      createConnectMockFetch({
        activities: [],
        sleepDates: [],
        stressDates: [],
        heartRateDates: [],
        dailySummaryPrivacyProtected: true,
      }),
    );

    const since = new Date("2026-03-01T00:00:00Z");
    await provider.sync(ctx.db, since);

    // No daily metrics should be inserted for privacy-protected days
    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "garmin"));
    expect(dailyRows).toHaveLength(0);
  });

  it("returns error when no tokens exist for Garmin", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "garmin"));

    const provider = new GarminProvider(createConnectMockFetch());
    const result = await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);
  });
});
