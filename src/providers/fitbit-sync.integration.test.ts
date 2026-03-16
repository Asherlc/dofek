import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activity, bodyMeasurement, dailyMetrics, sleepSession } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import {
  type FitbitActivity,
  type FitbitActivityListResponse,
  FitbitClient,
  type FitbitDailySummary,
  FitbitProvider,
  type FitbitSleepListResponse,
  type FitbitSleepLog,
  type FitbitWeightLog,
  fitbitOAuthConfig,
  mapFitbitActivityType,
  parseFitbitActivity,
  parseFitbitDailySummary,
  parseFitbitSleep,
  parseFitbitWeightLog,
} from "./fitbit.ts";

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

function fitbitHandlers(opts?: {
  activities?: FitbitActivity[];
  sleepResponse?: FitbitSleepListResponse;
  dailySummary?: FitbitDailySummary;
  weightLogs?: FitbitWeightLog[];
}) {
  const activities = opts?.activities ?? [];
  const sleepResponse = opts?.sleepResponse ?? {
    sleep: [],
    pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
  };
  const daily = opts?.dailySummary ?? fakeDailySummary();
  const weights = opts?.weightLogs ?? [];

  return [
    // Token refresh
    http.post("https://api.fitbit.com/oauth2/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-fitbit-token",
        refresh_token: "new-fitbit-refresh",
        expires_in: 28800,
        token_type: "Bearer",
      });
    }),

    // Activities list
    http.get("https://api.fitbit.com/1/user/-/activities/list.json", () => {
      const response: FitbitActivityListResponse = {
        activities,
        pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
      };
      return HttpResponse.json(response);
    }),

    // Sleep logs
    http.get("https://api.fitbit.com/1.2/user/-/sleep/list.json", () => {
      return HttpResponse.json(sleepResponse);
    }),

    // Daily summary (activities/date/YYYY-MM-DD.json)
    http.get("https://api.fitbit.com/1/user/-/activities/date/:date.json", () => {
      return HttpResponse.json(daily);
    }),

    // Weight logs
    http.get("https://api.fitbit.com/1/user/-/body/log/weight/date/:startDate/:range.json", () => {
      return HttpResponse.json({ weight: weights });
    }),
  ];
}

const server = setupServer();

describe("FitbitProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.FITBIT_CLIENT_ID = "test-fitbit-client";
    process.env.FITBIT_CLIENT_SECRET = "test-fitbit-secret";
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: "error" });
    await ensureProvider(ctx.db, "fitbit", "Fitbit", "https://api.fitbit.com");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
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

    server.use(
      ...fitbitHandlers({
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

    const provider = new FitbitProvider();
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

    server.use(
      ...fitbitHandlers({
        activities: [fakeActivity({ logId: 5001, startDate: "2026-03-01" })],
        sleepResponse: fakeSleepLog(),
        weightLogs: fakeWeightLogs(),
      }),
    );

    const provider = new FitbitProvider();
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

    server.use(...fitbitHandlers());

    const provider = new FitbitProvider();
    await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "fitbit");
    expect(tokens?.accessToken).toBe("refreshed-fitbit-token");
  });

  it("returns error when no tokens exist", async () => {
    const { oauthToken } = await import("../db/schema.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "fitbit"));

    const provider = new FitbitProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);
  });
});

// ============================================================
// Coverage tests for uncovered Fitbit paths
// ============================================================

describe("fitbitOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when FITBIT_CLIENT_ID is not set", () => {
    delete process.env.FITBIT_CLIENT_ID;
    delete process.env.FITBIT_CLIENT_SECRET;
    expect(fitbitOAuthConfig()).toBeNull();
  });

  it("returns null when FITBIT_CLIENT_SECRET is not set", () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    delete process.env.FITBIT_CLIENT_SECRET;
    expect(fitbitOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    process.env.FITBIT_CLIENT_SECRET = "test-secret";
    const config = fitbitOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("activity");
    expect(config?.scopes).toContain("sleep");
    expect(config?.usePkce).toBe(true);
  });

  it("uses custom OAUTH_REDIRECT_URI_unencrypted when set", () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    process.env.FITBIT_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI_unencrypted = "https://example.com/callback";
    const config = fitbitOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });
});

describe("FitbitProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when FITBIT_CLIENT_ID is missing", () => {
    delete process.env.FITBIT_CLIENT_ID;
    delete process.env.FITBIT_CLIENT_SECRET;
    const provider = new FitbitProvider();
    expect(provider.validate()).toContain("FITBIT_CLIENT_ID");
  });

  it("returns error when FITBIT_CLIENT_SECRET is missing", () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    delete process.env.FITBIT_CLIENT_SECRET;
    const provider = new FitbitProvider();
    expect(provider.validate()).toContain("FITBIT_CLIENT_SECRET");
  });

  it("returns null when both are set", () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    process.env.FITBIT_CLIENT_SECRET = "test-secret";
    const provider = new FitbitProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("FitbitProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    process.env.FITBIT_CLIENT_SECRET = "test-secret";
    const provider = new FitbitProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("fitbit.com");
  });

  it("throws when env vars are missing", () => {
    delete process.env.FITBIT_CLIENT_ID;
    delete process.env.FITBIT_CLIENT_SECRET;
    const provider = new FitbitProvider();
    expect(() => provider.authSetup()).toThrow("FITBIT_CLIENT_ID");
  });
});

describe("mapFitbitActivityType", () => {
  it("maps run/treadmill to running", () => {
    expect(mapFitbitActivityType("Morning Run", 0)).toBe("running");
    expect(mapFitbitActivityType("Treadmill Workout", 0)).toBe("running");
  });

  it("maps bike/cycling to cycling", () => {
    expect(mapFitbitActivityType("Outdoor Bike Ride", 0)).toBe("cycling");
    expect(mapFitbitActivityType("Indoor Cycling Class", 0)).toBe("cycling");
    expect(mapFitbitActivityType("Spinning", 0)).toBe("cycling");
  });

  it("maps walk to walking", () => {
    expect(mapFitbitActivityType("Walk", 0)).toBe("walking");
  });

  it("maps swim to swimming", () => {
    expect(mapFitbitActivityType("Swimming Laps", 0)).toBe("swimming");
  });

  it("maps hike to hiking", () => {
    expect(mapFitbitActivityType("Hike", 0)).toBe("hiking");
    expect(mapFitbitActivityType("Hiking Trail", 0)).toBe("hiking");
  });

  it("maps yoga to yoga", () => {
    expect(mapFitbitActivityType("Yoga", 0)).toBe("yoga");
  });

  it("maps weight/strength to strength", () => {
    expect(mapFitbitActivityType("Weight Lifting", 0)).toBe("strength");
    expect(mapFitbitActivityType("Strength Training", 0)).toBe("strength");
  });

  it("maps elliptical to elliptical", () => {
    expect(mapFitbitActivityType("Elliptical", 0)).toBe("elliptical");
  });

  it("maps rowing to rowing", () => {
    expect(mapFitbitActivityType("Rowing Machine", 0)).toBe("rowing");
  });

  it("maps unknown to other", () => {
    expect(mapFitbitActivityType("Kickboxing Class", 0)).toBe("other");
    expect(mapFitbitActivityType("Frisbee", 0)).toBe("other");
  });
});

describe("parseFitbitSleep — edge cases", () => {
  it("parses a nap (isMainSleep=false)", () => {
    const sleep: FitbitSleepLog = {
      logId: 1234,
      dateOfSleep: "2026-03-01",
      startTime: "2026-03-01T14:00:00.000",
      endTime: "2026-03-01T14:30:00.000",
      duration: 1800000,
      efficiency: 85,
      isMainSleep: false,
      type: "stages",
      levels: {
        summary: {
          deep: { count: 0, minutes: 0, thirtyDayAvgMinutes: 0 },
          light: { count: 2, minutes: 25, thirtyDayAvgMinutes: 20 },
          rem: { count: 0, minutes: 0, thirtyDayAvgMinutes: 0 },
          wake: { count: 1, minutes: 5, thirtyDayAvgMinutes: 5 },
        },
      },
    };

    const parsed = parseFitbitSleep(sleep);
    expect(parsed.isNap).toBe(true);
    expect(parsed.durationMinutes).toBe(30);
    expect(parsed.lightMinutes).toBe(25);
    expect(parsed.awakeMinutes).toBe(5);
    expect(parsed.deepMinutes).toBe(0);
  });

  it("handles classic sleep type with missing stage data", () => {
    const sleep: FitbitSleepLog = {
      logId: 5678,
      dateOfSleep: "2026-03-01",
      startTime: "2026-02-28T23:00:00.000",
      endTime: "2026-03-01T07:00:00.000",
      duration: 28800000,
      efficiency: 90,
      isMainSleep: true,
      type: "classic",
      levels: {
        summary: {},
      },
    };

    const parsed = parseFitbitSleep(sleep);
    expect(parsed.deepMinutes).toBeUndefined();
    expect(parsed.lightMinutes).toBeUndefined();
    expect(parsed.remMinutes).toBeUndefined();
    expect(parsed.awakeMinutes).toBeUndefined();
    expect(parsed.durationMinutes).toBe(480);
    expect(parsed.efficiencyPct).toBe(90);
  });
});

describe("parseFitbitDailySummary — edge cases", () => {
  it("handles missing total distance", () => {
    const daily: FitbitDailySummary = {
      summary: {
        steps: 5000,
        caloriesOut: 2000,
        activeScore: -1,
        activityCalories: 500,
        distances: [{ activity: "tracker", distance: 3.5 }],
        fairlyActiveMinutes: 10,
        veryActiveMinutes: 20,
        lightlyActiveMinutes: 100,
        sedentaryMinutes: 800,
      },
    };

    const parsed = parseFitbitDailySummary("2026-03-01", daily);
    expect(parsed.distanceKm).toBeUndefined();
    expect(parsed.exerciseMinutes).toBe(30);
  });

  it("handles missing resting heart rate", () => {
    const daily: FitbitDailySummary = {
      summary: {
        steps: 8000,
        caloriesOut: 2200,
        activeScore: -1,
        activityCalories: 700,
        distances: [{ activity: "total", distance: 6.0 }],
        fairlyActiveMinutes: 15,
        veryActiveMinutes: 30,
        lightlyActiveMinutes: 150,
        sedentaryMinutes: 700,
      },
    };

    const parsed = parseFitbitDailySummary("2026-03-01", daily);
    expect(parsed.restingHr).toBeUndefined();
    expect(parsed.distanceKm).toBe(6.0);
  });

  it("handles missing floors", () => {
    const daily: FitbitDailySummary = {
      summary: {
        steps: 10000,
        caloriesOut: 2500,
        activeScore: -1,
        activityCalories: 800,
        distances: [{ activity: "total", distance: 7.5 }],
        fairlyActiveMinutes: 20,
        veryActiveMinutes: 40,
        lightlyActiveMinutes: 180,
        sedentaryMinutes: 600,
      },
    };

    const parsed = parseFitbitDailySummary("2026-03-01", daily);
    expect(parsed.flightsClimbed).toBeUndefined();
  });
});

describe("parseFitbitWeightLog — edge cases", () => {
  it("handles weight without body fat", () => {
    const log: FitbitWeightLog = {
      logId: 9001,
      weight: 75.0,
      bmi: 23.5,
      date: "2026-03-01",
      time: "08:00:00",
    };

    const parsed = parseFitbitWeightLog(log);
    expect(parsed.weightKg).toBe(75.0);
    expect(parsed.bodyFatPct).toBeUndefined();
    expect(parsed.externalId).toBe("9001");
  });
});

describe("parseFitbitActivity — edge cases", () => {
  it("handles activity without steps", () => {
    const act: FitbitActivity = {
      logId: 3001,
      activityName: "Yoga",
      activityTypeId: 52001,
      startTime: "10:00",
      activeDuration: 3600000,
      calories: 200,
      distanceUnit: "",
      logType: "tracker",
      startDate: "2026-03-01",
    };

    const parsed = parseFitbitActivity(act);
    expect(parsed.steps).toBeUndefined();
    expect(parsed.distanceKm).toBeUndefined();
    expect(parsed.activityType).toBe("yoga");
  });
});

describe("FitbitClient — error handling", () => {
  beforeAll(() => {
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
  });

  it("throws on non-OK response", async () => {
    server.use(
      http.get("https://api.fitbit.com/1/user/-/activities/list.json", () => {
        return new HttpResponse("Unauthorized", { status: 401 });
      }),
    );

    const client = new FitbitClient("bad-token");
    await expect(client.getActivities("2026-03-01")).rejects.toThrow("Fitbit API error (401)");
  });

  it("throws on non-OK sleep response", async () => {
    server.use(
      http.get("https://api.fitbit.com/1.2/user/-/sleep/list.json", () => {
        return new HttpResponse("Server Error", { status: 500 });
      }),
    );

    const client = new FitbitClient("token");
    await expect(client.getSleepLogs("2026-03-01")).rejects.toThrow("Fitbit API error (500)");
  });

  it("throws on non-OK weight log response", async () => {
    server.use(
      http.get(
        "https://api.fitbit.com/1/user/-/body/log/weight/date/:startDate/:range.json",
        () => {
          return new HttpResponse("Rate Limited", { status: 429 });
        },
      ),
    );

    const client = new FitbitClient("token");
    await expect(client.getWeightLogs("2026-03-01")).rejects.toThrow("Fitbit API error (429)");
  });

  it("throws on non-OK daily summary response", async () => {
    server.use(
      http.get("https://api.fitbit.com/1/user/-/activities/date/:date.json", () => {
        return new HttpResponse("Forbidden", { status: 403 });
      }),
    );

    const client = new FitbitClient("token");
    await expect(client.getDailySummary("2026-03-01")).rejects.toThrow("Fitbit API error (403)");
  });
});

// ============================================================
// Integration tests for sync() weight error paths (lines 632-650)
// ============================================================

function fitbitWeightErrorHandlers(opts: { weightError?: boolean }) {
  return [
    // Token refresh
    http.post("https://api.fitbit.com/oauth2/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-fitbit-token",
        refresh_token: "new-fitbit-refresh",
        expires_in: 28800,
        token_type: "Bearer",
      });
    }),

    // Activities — return empty
    http.get("https://api.fitbit.com/1/user/-/activities/list.json", () => {
      const response: FitbitActivityListResponse = {
        activities: [],
        pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
      };
      return HttpResponse.json(response);
    }),

    // Sleep — return empty
    http.get("https://api.fitbit.com/1.2/user/-/sleep/list.json", () => {
      return HttpResponse.json({
        sleep: [],
        pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
      });
    }),

    // Daily summary — return valid
    http.get("https://api.fitbit.com/1/user/-/activities/date/:date.json", () => {
      return HttpResponse.json({
        summary: {
          steps: 5000,
          caloriesOut: 2000,
          activeScore: -1,
          activityCalories: 500,
          distances: [{ activity: "total", distance: 3.5 }],
          fairlyActiveMinutes: 10,
          veryActiveMinutes: 20,
          lightlyActiveMinutes: 100,
          sedentaryMinutes: 800,
        },
      });
    }),

    // Weight logs — return error or empty
    http.get("https://api.fitbit.com/1/user/-/body/log/weight/date/:startDate/:range.json", () => {
      if (opts.weightError) {
        return new HttpResponse("Rate Limited", { status: 429 });
      }
      return HttpResponse.json({ weight: [] });
    }),
  ];
}

describe("FitbitProvider.sync() — weight error paths (integration)", () => {
  let ctx: TestContext;
  const weightServer = setupServer();

  beforeAll(async () => {
    process.env.FITBIT_CLIENT_ID = "test-fitbit-client";
    process.env.FITBIT_CLIENT_SECRET = "test-fitbit-secret";
    ctx = await setupTestDatabase();
    weightServer.listen({ onUnhandledRequest: "error" });
    server.listen({ onUnhandledRequest: "error" });
    await ensureProvider(ctx.db, "fitbit", "Fitbit", "https://api.fitbit.com");
  }, 60_000);

  afterEach(() => {
    weightServer.resetHandlers();
  });

  afterAll(async () => {
    weightServer.close();
    if (ctx) await ctx.cleanup();
  });

  it("captures per-window weight fetch errors (lines 632-636)", async () => {
    await saveTokens(ctx.db, "fitbit", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "activity heartrate sleep weight",
    });

    // Use a narrow since so the daily loop isn't too long
    const since = new Date();
    since.setDate(since.getDate() - 1);

    weightServer.use(...fitbitWeightErrorHandlers({ weightError: true }));

    const provider = new FitbitProvider();
    const result = await provider.sync(ctx.db, since);

    // The weight fetch returns 429, caught at lines 632-636
    const weightError = result.errors.find((e) => e.message.includes("weight"));
    expect(weightError).toBeDefined();
  });
});

describe("FitbitProvider.getUserIdentity()", () => {
  const originalEnv = { ...process.env };
  const identityServer = setupServer();

  beforeAll(() => {
    identityServer.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    identityServer.resetHandlers();
  });

  afterAll(() => {
    identityServer.close();
  });

  it("returns identity from profile API", async () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    process.env.FITBIT_CLIENT_SECRET = "test-secret";

    identityServer.use(
      http.get("https://api.fitbit.com/1/user/-/profile.json", () => {
        return HttpResponse.json({ user: { encodedId: "ABC123", displayName: "Fit User" } });
      }),
    );

    const provider = new FitbitProvider();
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    const identity = await setup.getUserIdentity("test-token");
    expect(identity.providerAccountId).toBe("ABC123");
    expect(identity.email).toBeNull();
    expect(identity.name).toBe("Fit User");
  });

  it("throws on API error", async () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    process.env.FITBIT_CLIENT_SECRET = "test-secret";

    identityServer.use(
      http.get("https://api.fitbit.com/1/user/-/profile.json", () => {
        return new HttpResponse("Too Many Requests", { status: 429 });
      }),
    );

    const provider = new FitbitProvider();
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    await expect(setup.getUserIdentity("bad-token")).rejects.toThrow(
      "Fitbit profile API error (429)",
    );
  });
});
