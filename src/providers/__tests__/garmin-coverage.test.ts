import { afterEach, describe, expect, it } from "vitest";
import {
  type GarminActivitySummary,
  type GarminBodyComposition,
  GarminClient,
  type GarminDailySummary,
  GarminProvider,
  type GarminSleepSummary,
  garminOAuthConfig,
  mapGarminActivityType,
  parseGarminActivity,
  parseGarminBodyComposition,
  parseGarminDailySummary,
  parseGarminSleep,
} from "../garmin.ts";

// ============================================================
// Coverage tests for uncovered Garmin paths:
// - garminOAuthConfig with/without env vars
// - GarminProvider.validate()
// - GarminProvider.authSetup()
// - mapGarminActivityType with all mapped and unmapped types
// - parseGarminActivity basic fields
// - parseGarminSleep basic fields
// - parseGarminDailySummary with missing optional fields
// - parseGarminBodyComposition with missing optional fields
// - GarminClient error handling
// ============================================================

describe("garminOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when GARMIN_CLIENT_ID is not set", () => {
    delete process.env.GARMIN_CLIENT_ID;
    expect(garminOAuthConfig()).toBeNull();
  });

  it("returns config when GARMIN_CLIENT_ID is set", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    process.env.GARMIN_CLIENT_SECRET = "test-secret";
    const config = garminOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.usePkce).toBe(true);
    expect(config?.scopes).toEqual([]);
  });

  it("returns config without clientSecret when not set", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    delete process.env.GARMIN_CLIENT_SECRET;
    const config = garminOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientSecret).toBeUndefined();
  });

  it("uses custom OAUTH_REDIRECT_URI_unencrypted when set", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    process.env.OAUTH_REDIRECT_URI_unencrypted = "https://example.com/callback";
    const config = garminOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when OAUTH_REDIRECT_URI_unencrypted is not set", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    delete process.env.OAUTH_REDIRECT_URI_unencrypted;
    const config = garminOAuthConfig();
    expect(config?.redirectUri).toContain("dofek");
  });
});

describe("GarminProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when GARMIN_CLIENT_ID is missing", () => {
    delete process.env.GARMIN_CLIENT_ID;
    const provider = new GarminProvider();
    expect(provider.validate()).toContain("GARMIN_CLIENT_ID");
  });

  it("returns null when GARMIN_CLIENT_ID is set", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    const provider = new GarminProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("GarminProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    process.env.GARMIN_CLIENT_SECRET = "test-secret";
    const provider = new GarminProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("garmin.com");
  });

  it("throws when GARMIN_CLIENT_ID is missing", () => {
    delete process.env.GARMIN_CLIENT_ID;
    const provider = new GarminProvider();
    expect(() => provider.authSetup()).toThrow("GARMIN_CLIENT_ID");
  });
});

describe("mapGarminActivityType", () => {
  it("maps running types", () => {
    expect(mapGarminActivityType("RUNNING")).toBe("running");
    expect(mapGarminActivityType("TRAIL_RUNNING")).toBe("running");
    expect(mapGarminActivityType("TREADMILL_RUNNING")).toBe("running");
    expect(mapGarminActivityType("TRACK_RUNNING")).toBe("running");
  });

  it("maps cycling types", () => {
    expect(mapGarminActivityType("CYCLING")).toBe("cycling");
    expect(mapGarminActivityType("MOUNTAIN_BIKING")).toBe("cycling");
    expect(mapGarminActivityType("ROAD_BIKING")).toBe("cycling");
    expect(mapGarminActivityType("INDOOR_CYCLING")).toBe("cycling");
    expect(mapGarminActivityType("GRAVEL_CYCLING")).toBe("cycling");
    expect(mapGarminActivityType("VIRTUAL_RIDE")).toBe("cycling");
  });

  it("maps swimming types", () => {
    expect(mapGarminActivityType("SWIMMING")).toBe("swimming");
    expect(mapGarminActivityType("LAP_SWIMMING")).toBe("swimming");
    expect(mapGarminActivityType("OPEN_WATER_SWIMMING")).toBe("swimming");
  });

  it("maps walking and hiking", () => {
    expect(mapGarminActivityType("WALKING")).toBe("walking");
    expect(mapGarminActivityType("HIKING")).toBe("hiking");
  });

  it("maps strength and cardio", () => {
    expect(mapGarminActivityType("STRENGTH_TRAINING")).toBe("strength");
    expect(mapGarminActivityType("INDOOR_CARDIO")).toBe("cardio");
  });

  it("maps other fitness types", () => {
    expect(mapGarminActivityType("YOGA")).toBe("yoga");
    expect(mapGarminActivityType("PILATES")).toBe("pilates");
    expect(mapGarminActivityType("ELLIPTICAL")).toBe("elliptical");
    expect(mapGarminActivityType("ROWING")).toBe("rowing");
  });

  it("maps unknown types to other", () => {
    expect(mapGarminActivityType("UNKNOWN_TYPE")).toBe("other");
    expect(mapGarminActivityType("SURFING")).toBe("other");
  });
});

describe("parseGarminActivity", () => {
  const baseActivity: GarminActivitySummary = {
    activityId: 12345,
    activityName: "Morning Run",
    activityType: "RUNNING",
    startTimeInSeconds: 1709280000,
    startTimeOffsetInSeconds: -18000,
    durationInSeconds: 3600,
    distanceInMeters: 10000,
    averageHeartRateInBeatsPerMinute: 155,
    maxHeartRateInBeatsPerMinute: 178,
  };

  it("parses basic fields", () => {
    const parsed = parseGarminActivity(baseActivity);
    expect(parsed.externalId).toBe("12345");
    expect(parsed.activityType).toBe("running");
    expect(parsed.name).toBe("Morning Run");
    expect(parsed.startedAt).toEqual(new Date(1709280000 * 1000));
    expect(parsed.endedAt).toEqual(new Date((1709280000 + 3600) * 1000));
  });

  it("stores raw activity data", () => {
    const parsed = parseGarminActivity(baseActivity);
    expect(parsed.raw.activityId).toBe(12345);
    expect(parsed.raw.averageHeartRateInBeatsPerMinute).toBe(155);
  });

  it("handles unknown activity type", () => {
    const activity = { ...baseActivity, activityType: "KICKBOXING" };
    const parsed = parseGarminActivity(activity);
    expect(parsed.activityType).toBe("other");
  });
});

describe("parseGarminSleep", () => {
  const baseSleep: GarminSleepSummary = {
    calendarDate: "2026-03-01",
    startTimeInSeconds: 1772100000,
    startTimeOffsetInSeconds: -18000,
    durationInSeconds: 28800,
    deepSleepDurationInSeconds: 5400,
    lightSleepDurationInSeconds: 12600,
    remSleepInSeconds: 6300,
    awakeDurationInSeconds: 4500,
  };

  it("parses sleep durations to minutes", () => {
    const parsed = parseGarminSleep(baseSleep);
    expect(parsed.durationMinutes).toBe(480);
    expect(parsed.deepMinutes).toBe(90);
    expect(parsed.lightMinutes).toBe(210);
    expect(parsed.remMinutes).toBe(105);
    expect(parsed.awakeMinutes).toBe(75);
  });

  it("uses calendarDate as externalId", () => {
    const parsed = parseGarminSleep(baseSleep);
    expect(parsed.externalId).toBe("2026-03-01");
  });

  it("computes startedAt and endedAt from epoch seconds", () => {
    const parsed = parseGarminSleep(baseSleep);
    expect(parsed.startedAt).toEqual(new Date(1772100000 * 1000));
    expect(parsed.endedAt).toEqual(new Date((1772100000 + 28800) * 1000));
  });
});

describe("parseGarminDailySummary — edge cases", () => {
  it("handles missing exercise minutes when neither moderate nor vigorous are set", () => {
    const summary: GarminDailySummary = {
      calendarDate: "2026-03-01",
      startTimeInSeconds: 1772100000,
      startTimeOffsetInSeconds: -18000,
      durationInSeconds: 86400,
      steps: 8000,
      distanceInMeters: 6000,
      activeKilocalories: 500,
      bmrKilocalories: 1700,
    };

    const parsed = parseGarminDailySummary(summary);
    expect(parsed.exerciseMinutes).toBeUndefined();
    expect(parsed.restingHr).toBeUndefined();
    expect(parsed.spo2Avg).toBeUndefined();
    expect(parsed.respiratoryRateAvg).toBeUndefined();
    expect(parsed.flightsClimbed).toBeUndefined();
  });

  it("computes exercise minutes from only moderate intensity", () => {
    const summary: GarminDailySummary = {
      calendarDate: "2026-03-01",
      startTimeInSeconds: 1772100000,
      startTimeOffsetInSeconds: -18000,
      durationInSeconds: 86400,
      steps: 8000,
      distanceInMeters: 6000,
      activeKilocalories: 500,
      bmrKilocalories: 1700,
      moderateIntensityDurationInSeconds: 1800,
    };

    const parsed = parseGarminDailySummary(summary);
    expect(parsed.exerciseMinutes).toBe(30);
  });

  it("computes exercise minutes from only vigorous intensity", () => {
    const summary: GarminDailySummary = {
      calendarDate: "2026-03-01",
      startTimeInSeconds: 1772100000,
      startTimeOffsetInSeconds: -18000,
      durationInSeconds: 86400,
      steps: 8000,
      distanceInMeters: 6000,
      activeKilocalories: 500,
      bmrKilocalories: 1700,
      vigorousIntensityDurationInSeconds: 2400,
    };

    const parsed = parseGarminDailySummary(summary);
    expect(parsed.exerciseMinutes).toBe(40);
  });

  it("converts distance from meters to km", () => {
    const summary: GarminDailySummary = {
      calendarDate: "2026-03-01",
      startTimeInSeconds: 1772100000,
      startTimeOffsetInSeconds: -18000,
      durationInSeconds: 86400,
      steps: 10000,
      distanceInMeters: 7500,
      activeKilocalories: 600,
      bmrKilocalories: 1700,
    };

    const parsed = parseGarminDailySummary(summary);
    expect(parsed.distanceKm).toBe(7.5);
  });
});

describe("parseGarminBodyComposition — edge cases", () => {
  it("handles missing optional fields", () => {
    const entry: GarminBodyComposition = {
      measurementTimeInSeconds: 1709280000,
      weightInGrams: 75000,
    };

    const parsed = parseGarminBodyComposition(entry);
    expect(parsed.weightKg).toBe(75);
    expect(parsed.bmi).toBeUndefined();
    expect(parsed.bodyFatPct).toBeUndefined();
    expect(parsed.muscleMassKg).toBeUndefined();
    expect(parsed.boneMassKg).toBeUndefined();
    expect(parsed.waterPct).toBeUndefined();
    expect(parsed.externalId).toBe(String(1709280000));
  });

  it("converts muscle and bone mass from grams to kg", () => {
    const entry: GarminBodyComposition = {
      measurementTimeInSeconds: 1709280000,
      weightInGrams: 80000,
      muscleMassInGrams: 35000,
      boneMassInGrams: 3200,
    };

    const parsed = parseGarminBodyComposition(entry);
    expect(parsed.muscleMassKg).toBe(35);
    expect(parsed.boneMassKg).toBe(3.2);
  });

  it("includes all fields when present", () => {
    const entry: GarminBodyComposition = {
      measurementTimeInSeconds: 1709280000,
      measurementTimeOffsetInSeconds: -18000,
      weightInGrams: 81500,
      bmi: 24.8,
      bodyFatInPercent: 17.2,
      muscleMassInGrams: 35200,
      boneMassInGrams: 3100,
      bodyWaterInPercent: 58.5,
    };

    const parsed = parseGarminBodyComposition(entry);
    expect(parsed.weightKg).toBe(81.5);
    expect(parsed.bmi).toBe(24.8);
    expect(parsed.bodyFatPct).toBe(17.2);
    expect(parsed.muscleMassKg).toBe(35.2);
    expect(parsed.boneMassKg).toBe(3.1);
    expect(parsed.waterPct).toBe(58.5);
    expect(parsed.recordedAt).toEqual(new Date(1709280000 * 1000));
  });
});

describe("GarminClient — error handling", () => {
  it("throws on non-OK response from activities endpoint", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof globalThis.fetch;

    const client = new GarminClient("bad-token", mockFetch);
    await expect(client.getActivities(0, 1000)).rejects.toThrow("Garmin API error (401)");
  });

  it("throws on non-OK response from sleep endpoint", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Server Error", { status: 500 });
    }) as typeof globalThis.fetch;

    const client = new GarminClient("token", mockFetch);
    await expect(client.getSleep(0, 1000)).rejects.toThrow("Garmin API error (500)");
  });

  it("throws on non-OK response from daily summaries endpoint", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Forbidden", { status: 403 });
    }) as typeof globalThis.fetch;

    const client = new GarminClient("token", mockFetch);
    await expect(client.getDailySummaries(0, 1000)).rejects.toThrow("Garmin API error (403)");
  });

  it("throws on non-OK response from body composition endpoint", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Not Found", { status: 404 });
    }) as typeof globalThis.fetch;

    const client = new GarminClient("token", mockFetch);
    await expect(client.getBodyComposition(0, 1000)).rejects.toThrow("Garmin API error (404)");
  });
});
