import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import {
  type FitbitActivity,
  type FitbitActivityListResponse,
  FitbitClient,
  type FitbitDailySummary,
  FitbitProvider,
  type FitbitSleepLog,
  type FitbitWeightLog,
  fitbitOAuthConfig,
  mapFitbitActivityType,
  parseFitbitActivity,
  parseFitbitDailySummary,
  parseFitbitSleep,
  parseFitbitWeightLog,
} from "../fitbit.ts";

const server = setupServer();

// ============================================================
// Coverage tests for uncovered Fitbit paths:
// - fitbitOAuthConfig with/without env vars
// - FitbitProvider.validate() and authSetup()
// - mapFitbitActivityType with various names
// - parseFitbitActivity edge cases
// - parseFitbitSleep with nap and classic type
// - parseFitbitDailySummary with missing distances
// - parseFitbitWeightLog with missing body fat
// - FitbitClient error handling
// - Lines 632-636: weight log fetch error per window
// - Lines 646-650: outer catch around body_measurement withSyncLog
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
    server.listen({ onUnhandledRequest: "error" });
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
      http.get("https://api.fitbit.com/1/user/-/body/log/weight/date/:startDate/:range.json", () => {
        return new HttpResponse("Rate Limited", { status: 429 });
      }),
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

const weightServer = setupServer();

describe("FitbitProvider.sync() — weight error paths (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    weightServer.listen({ onUnhandledRequest: "error" });
    process.env.FITBIT_CLIENT_ID = "test-fitbit-client";
    process.env.FITBIT_CLIENT_SECRET = "test-fitbit-secret";
    ctx = await setupTestDatabase();
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
