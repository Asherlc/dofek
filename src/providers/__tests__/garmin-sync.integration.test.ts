import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { activity, bodyMeasurement, dailyMetrics, sleepSession } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import type {
  GarminActivitySummary,
  GarminBodyComposition,
  GarminDailySummary,
  GarminSleepSummary,
} from "../garmin.ts";
import { GarminProvider } from "../garmin.ts";

// 2026-03-01T10:00:00Z as epoch seconds
const MARCH_1_EPOCH = 1772110800;

function fakeGarminActivity(overrides: Partial<GarminActivitySummary> = {}): GarminActivitySummary {
  return {
    activityId: 9001,
    activityName: "Morning Run",
    activityType: "RUNNING",
    startTimeInSeconds: MARCH_1_EPOCH,
    startTimeOffsetInSeconds: -18000,
    durationInSeconds: 3600,
    distanceInMeters: 10500,
    averageHeartRateInBeatsPerMinute: 155,
    maxHeartRateInBeatsPerMinute: 178,
    averageSpeedInMetersPerSecond: 2.92,
    activeKilocalories: 720,
    averageRunCadenceInStepsPerMinute: 172,
    totalElevationGainInMeters: 85,
    ...overrides,
  };
}

function fakeGarminSleep(overrides: Partial<GarminSleepSummary> = {}): GarminSleepSummary {
  return {
    calendarDate: "2026-03-01",
    startTimeInSeconds: MARCH_1_EPOCH - 36000, // 10h before noon = 2am-ish
    startTimeOffsetInSeconds: -18000,
    durationInSeconds: 28800, // 8h
    deepSleepDurationInSeconds: 5400, // 90m
    lightSleepDurationInSeconds: 12600, // 210m
    remSleepInSeconds: 6300, // 105m
    awakeDurationInSeconds: 4500, // 75m
    averageSpO2Value: 96.5,
    overallSleepScore: 82,
    ...overrides,
  };
}

function fakeGarminDaily(overrides: Partial<GarminDailySummary> = {}): GarminDailySummary {
  return {
    calendarDate: "2026-03-01",
    startTimeInSeconds: MARCH_1_EPOCH - 36000,
    startTimeOffsetInSeconds: -18000,
    durationInSeconds: 86400,
    steps: 12543,
    distanceInMeters: 9850,
    activeKilocalories: 920,
    bmrKilocalories: 1750,
    restingHeartRateInBeatsPerMinute: 55,
    averageSpo2: 97,
    respirationAvg: 15.2,
    floorsClimbed: 14,
    moderateIntensityDurationInSeconds: 1800,
    vigorousIntensityDurationInSeconds: 2400,
    ...overrides,
  };
}

function fakeGarminBody(overrides: Partial<GarminBodyComposition> = {}): GarminBodyComposition {
  return {
    measurementTimeInSeconds: MARCH_1_EPOCH,
    measurementTimeOffsetInSeconds: -18000,
    weightInGrams: 81500,
    bmi: 24.8,
    bodyFatInPercent: 17.2,
    muscleMassInGrams: 35200,
    boneMassInGrams: 3100,
    bodyWaterInPercent: 58.5,
    ...overrides,
  };
}

function garminHandlers(opts?: {
  activities?: GarminActivitySummary[];
  sleep?: GarminSleepSummary[];
  dailies?: GarminDailySummary[];
  bodyComp?: GarminBodyComposition[];
}) {
  const activities = opts?.activities ?? [];
  const sleep = opts?.sleep ?? [];
  const dailies = opts?.dailies ?? [];
  const bodyComp = opts?.bodyComp ?? [];

  return [
    // Token refresh (Garmin uses diauth.garmin.com)
    http.post("https://diauth.garmin.com/di-oauth2-service/oauth/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-garmin-token",
        refresh_token: "new-garmin-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }),

    // Activities
    http.get("https://apis.garmin.com/wellness-api/rest/activities", () => {
      return HttpResponse.json(activities);
    }),

    // Sleep
    http.get("https://apis.garmin.com/wellness-api/rest/sleep", () => {
      return HttpResponse.json(sleep);
    }),

    // Daily summaries
    http.get("https://apis.garmin.com/wellness-api/rest/dailies", () => {
      return HttpResponse.json(dailies);
    }),

    // Body composition
    http.get("https://apis.garmin.com/wellness-api/rest/bodyComposition", () => {
      return HttpResponse.json(bodyComp);
    }),
  ];
}

const server = setupServer();

describe("GarminProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" });
    process.env.GARMIN_CLIENT_ID = "test-garmin-client";
    process.env.GARMIN_CLIENT_SECRET = "test-garmin-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(
      ctx.db,
      "garmin",
      "Garmin Connect",
      "https://apis.garmin.com/wellness-api/rest",
    );
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs activities, sleep, daily metrics, and body composition", async () => {
    await saveTokens(ctx.db, "garmin", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "",
    });

    server.use(
      ...garminHandlers({
        activities: [
          fakeGarminActivity({ activityId: 9001 }),
          fakeGarminActivity({
            activityId: 9002,
            activityName: "Afternoon Ride",
            activityType: "CYCLING",
            startTimeInSeconds: MARCH_1_EPOCH + 28800,
          }),
        ],
        sleep: [fakeGarminSleep()],
        dailies: [fakeGarminDaily()],
        bodyComp: [fakeGarminBody()],
      }),
    );

    const provider = new GarminProvider();
    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("garmin");
    expect(result.errors).toHaveLength(0);

    // Verify activities
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "garmin"));
    expect(activityRows).toHaveLength(2);

    const run = activityRows.find((r) => r.externalId === "9001");
    if (!run) throw new Error("expected activity 9001");
    expect(run.activityType).toBe("running");
    expect(run.name).toBe("Morning Run");

    const ride = activityRows.find((r) => r.externalId === "9002");
    if (!ride) throw new Error("expected activity 9002");
    expect(ride.activityType).toBe("cycling");

    // Verify sleep
    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "garmin"));
    expect(sleepRows).toHaveLength(1);

    const sleepRecord = sleepRows[0];
    if (!sleepRecord) throw new Error("expected sleep session");
    expect(sleepRecord.deepMinutes).toBe(90);
    expect(sleepRecord.lightMinutes).toBe(210);
    expect(sleepRecord.remMinutes).toBe(105);
    expect(sleepRecord.awakeMinutes).toBe(75);
    expect(sleepRecord.durationMinutes).toBe(480);

    // Verify daily metrics
    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "garmin"));
    expect(dailyRows).toHaveLength(1);

    const daily = dailyRows[0];
    if (!daily) throw new Error("expected daily metrics");
    expect(daily.steps).toBe(12543);
    expect(daily.restingHr).toBe(55);
    expect(daily.spo2Avg).toBeCloseTo(97);
    expect(daily.flightsClimbed).toBe(14);
    expect(daily.exerciseMinutes).toBe(70); // (1800+2400)/60

    // Verify body composition
    const bodyRows = await ctx.db
      .select()
      .from(bodyMeasurement)
      .where(eq(bodyMeasurement.providerId, "garmin"));
    expect(bodyRows).toHaveLength(1);

    const body = bodyRows[0];
    if (!body) throw new Error("expected body measurement");
    expect(body.weightKg).toBeCloseTo(81.5);
    expect(body.bodyFatPct).toBeCloseTo(17.2);
    expect(body.muscleMassKg).toBeCloseTo(35.2);
    expect(body.boneMassKg).toBeCloseTo(3.1);
    expect(body.waterPct).toBeCloseTo(58.5);
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "garmin", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "",
    });

    server.use(
      ...garminHandlers({
        activities: [fakeGarminActivity({ activityId: 9001 })],
        sleep: [fakeGarminSleep()],
        dailies: [fakeGarminDaily()],
        bodyComp: [fakeGarminBody()],
      }),
    );

    const provider = new GarminProvider();
    const since = new Date("2026-02-01T00:00:00Z");
    await provider.sync(ctx.db, since);
    await provider.sync(ctx.db, since);

    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "garmin"));
    const countOf9001 = activityRows.filter((r) => r.externalId === "9001").length;
    expect(countOf9001).toBe(1);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "garmin", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"),
      scopes: "",
    });

    server.use(...garminHandlers());

    const provider = new GarminProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const { loadTokens } = await import("../../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "garmin");
    expect(tokens?.accessToken).toBe("refreshed-garmin-token");
  });

  it("returns error when no tokens exist", async () => {
    const { oauthToken } = await import("../../db/schema.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "garmin"));

    const provider = new GarminProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);
  });
});
