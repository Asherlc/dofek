import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activity, bodyMeasurement, dailyMetrics, sleepSession } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import type {
  FitbitActivity,
  FitbitActivityListResponse,
  FitbitDailySummary,
  FitbitSleepListResponse,
  FitbitWeightLog,
} from "./fitbit.ts";
import { FitbitProvider } from "./fitbit.ts";

function fakeActivity(overrides: Partial<FitbitActivity> = {}): FitbitActivity {
  return {
    logId: 5001,
    activityName: "Outdoor Bike Ride",
    activityTypeId: 90001,
    startTime: "10:00",
    activeDuration: 3600000, // 1h in ms
    calories: 650,
    distance: 32.5,
    distanceUnit: "Kilometer",
    steps: undefined,
    averageHeartRate: 148,
    heartRateZones: [
      { name: "Fat Burn", min: 120, max: 140, minutes: 15 },
      { name: "Cardio", min: 140, max: 170, minutes: 40 },
    ],
    logType: "tracker",
    startDate: "2026-03-01",
    ...overrides,
  };
}

function fakeSleepLog(): FitbitSleepListResponse {
  return {
    sleep: [
      {
        logId: 6001,
        dateOfSleep: "2026-03-01",
        startTime: "2026-02-28T22:30:00.000",
        endTime: "2026-03-01T06:15:00.000",
        duration: 27900000, // 7h45m in ms
        efficiency: 92,
        isMainSleep: true,
        type: "stages",
        levels: {
          summary: {
            deep: { count: 3, minutes: 85, thirtyDayAvgMinutes: 80 },
            light: { count: 20, minutes: 200, thirtyDayAvgMinutes: 210 },
            rem: { count: 5, minutes: 105, thirtyDayAvgMinutes: 95 },
            wake: { count: 12, minutes: 35, thirtyDayAvgMinutes: 40 },
          },
        },
      },
    ],
    pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
  };
}

function fakeDailySummary(): FitbitDailySummary {
  return {
    summary: {
      steps: 10432,
      caloriesOut: 2450,
      activeScore: -1,
      activityCalories: 850,
      restingHeartRate: 58,
      distances: [
        { activity: "total", distance: 7.85 },
        { activity: "tracker", distance: 7.85 },
      ],
      fairlyActiveMinutes: 25,
      veryActiveMinutes: 45,
      lightlyActiveMinutes: 180,
      sedentaryMinutes: 680,
      floors: 12,
    },
  };
}

function fakeWeightLogs(): FitbitWeightLog[] {
  return [
    {
      logId: 7001,
      weight: 82.5,
      bmi: 25.1,
      fat: 18.3,
      date: "2026-03-01",
      time: "07:30:00",
    },
  ];
}

function createMockFetch(opts?: {
  activities?: FitbitActivity[];
  sleepResponse?: FitbitSleepListResponse;
  dailySummary?: FitbitDailySummary;
  weightLogs?: FitbitWeightLog[];
}): typeof globalThis.fetch {
  const activities = opts?.activities ?? [];
  const sleepResponse = opts?.sleepResponse ?? {
    sleep: [],
    pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
  };
  const daily = opts?.dailySummary ?? fakeDailySummary();
  const weights = opts?.weightLogs ?? [];

  return (async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const urlStr = input.toString();

    // Token refresh
    if (urlStr.includes("/oauth2/token")) {
      return Response.json({
        access_token: "refreshed-fitbit-token",
        refresh_token: "new-fitbit-refresh",
        expires_in: 28800,
        token_type: "Bearer",
      });
    }

    // Activities list
    if (urlStr.includes("/activities/list.json")) {
      const response: FitbitActivityListResponse = {
        activities,
        pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
      };
      return Response.json(response);
    }

    // Sleep logs
    if (urlStr.includes("/sleep/list.json")) {
      return Response.json(sleepResponse);
    }

    // Daily summary (activities/date/YYYY-MM-DD.json)
    if (urlStr.match(/\/activities\/date\/\d{4}-\d{2}-\d{2}\.json/)) {
      return Response.json(daily);
    }

    // Weight logs
    if (urlStr.includes("/body/log/weight/date/")) {
      return Response.json({ weight: weights });
    }

    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("FitbitProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.FITBIT_CLIENT_ID = "test-fitbit-client";
    process.env.FITBIT_CLIENT_SECRET = "test-fitbit-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "fitbit", "Fitbit", "https://api.fitbit.com");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("syncs activities, sleep, daily metrics, and weight", async () => {
    await saveTokens(ctx.db, "fitbit", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "activity heartrate sleep weight",
    });

    // Use a very narrow "since" window so daily iteration only covers 1 day
    const since = new Date("2026-03-01T00:00:00Z");

    const provider = new FitbitProvider(
      createMockFetch({
        activities: [
          fakeActivity({ logId: 5001, startDate: "2026-03-01" }),
          fakeActivity({
            logId: 5002,
            activityName: "Treadmill Run",
            activityTypeId: 90009,
            startDate: "2026-03-01",
            startTime: "18:00",
          }),
        ],
        sleepResponse: fakeSleepLog(),
        dailySummary: fakeDailySummary(),
        weightLogs: fakeWeightLogs(),
      }),
    );

    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("fitbit");
    expect(result.errors).toHaveLength(0);

    // Verify activities
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "fitbit"));
    expect(activityRows).toHaveLength(2);

    const ride = activityRows.find((r) => r.externalId === "5001");
    if (!ride) throw new Error("expected activity 5001");
    expect(ride.activityType).toBe("cycling");
    expect(ride.name).toBe("Outdoor Bike Ride");

    const run = activityRows.find((r) => r.externalId === "5002");
    if (!run) throw new Error("expected activity 5002");
    expect(run.activityType).toBe("running");

    // Verify sleep
    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "fitbit"));
    expect(sleepRows).toHaveLength(1);

    const sleep = sleepRows[0];
    if (!sleep) throw new Error("expected sleep session");
    expect(sleep.deepMinutes).toBe(85);
    expect(sleep.remMinutes).toBe(105);
    expect(sleep.lightMinutes).toBe(200);
    expect(sleep.awakeMinutes).toBe(35);
    expect(sleep.efficiencyPct).toBe(92);
    expect(sleep.isNap).toBe(false);

    // Verify daily metrics (since covers only 2026-03-01 to today, but mock returns same data)
    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "fitbit"));
    expect(dailyRows.length).toBeGreaterThanOrEqual(1);

    const firstDaily = dailyRows[0];
    if (!firstDaily) throw new Error("expected daily metrics");
    expect(firstDaily.steps).toBe(10432);
    expect(firstDaily.restingHr).toBe(58);
    expect(firstDaily.exerciseMinutes).toBe(70); // 25 + 45
    expect(firstDaily.flightsClimbed).toBe(12);

    // Verify weight
    const weightRows = await ctx.db
      .select()
      .from(bodyMeasurement)
      .where(eq(bodyMeasurement.providerId, "fitbit"));
    expect(weightRows).toHaveLength(1);

    const weight = weightRows[0];
    if (!weight) throw new Error("expected body measurement");
    expect(weight.weightKg).toBeCloseTo(82.5);
    expect(weight.bodyFatPct).toBeCloseTo(18.3);
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "fitbit", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "activity heartrate sleep weight",
    });

    const since = new Date("2026-03-01T00:00:00Z");

    const provider = new FitbitProvider(
      createMockFetch({
        activities: [fakeActivity({ logId: 5001, startDate: "2026-03-01" })],
        sleepResponse: fakeSleepLog(),
        weightLogs: fakeWeightLogs(),
      }),
    );

    await provider.sync(ctx.db, since);
    await provider.sync(ctx.db, since);

    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "fitbit"));
    const countOf5001 = activityRows.filter((r) => r.externalId === "5001").length;
    expect(countOf5001).toBe(1);

    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "fitbit"));
    const countOfSleep = sleepRows.filter((r) => r.externalId === "6001").length;
    expect(countOfSleep).toBe(1);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "fitbit", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"),
      scopes: "activity heartrate sleep weight",
    });

    const provider = new FitbitProvider(createMockFetch());
    await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "fitbit");
    expect(tokens?.accessToken).toBe("refreshed-fitbit-token");
  });

  it("returns error when no tokens exist", async () => {
    const { oauthToken } = await import("../db/schema.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "fitbit"));

    const provider = new FitbitProvider(createMockFetch());
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);
  });
});
