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
} from "./garmin.ts";

// ============================================================
// Activity type mapping
// ============================================================

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

  it("maps strength training", () => {
    expect(mapGarminActivityType("STRENGTH_TRAINING")).toBe("strength");
    expect(mapGarminActivityType("INDOOR_CARDIO")).toBe("cardio");
  });

  it("maps yoga and other fitness types", () => {
    expect(mapGarminActivityType("YOGA")).toBe("yoga");
    expect(mapGarminActivityType("PILATES")).toBe("pilates");
    expect(mapGarminActivityType("ELLIPTICAL")).toBe("elliptical");
    expect(mapGarminActivityType("ROWING")).toBe("rowing");
  });

  it("returns 'other' for unknown types", () => {
    expect(mapGarminActivityType("PARAGLIDING")).toBe("other");
    expect(mapGarminActivityType("")).toBe("other");
  });
});

// ============================================================
// Activity parsing
// ============================================================

// 2024-06-15T14:30:00Z = 1718461800 epoch seconds
const sampleActivity: GarminActivitySummary = {
  activityId: 12345678,
  activityName: "Morning Run",
  activityType: "RUNNING",
  startTimeInSeconds: 1718461800, // 2024-06-15T14:30:00Z
  startTimeOffsetInSeconds: -14400,
  durationInSeconds: 3600,
  distanceInMeters: 10000,
  averageHeartRateInBeatsPerMinute: 155,
  maxHeartRateInBeatsPerMinute: 185,
  averageSpeedInMetersPerSecond: 2.78,
  activeKilocalories: 750,
  totalElevationGainInMeters: 120.5,
  totalElevationLossInMeters: 115.2,
  averageRunCadenceInStepsPerMinute: 170,
};

describe("parseGarminActivity", () => {
  it("maps all fields correctly", () => {
    const result = parseGarminActivity(sampleActivity);
    expect(result.externalId).toBe("12345678");
    expect(result.activityType).toBe("running");
    expect(result.name).toBe("Morning Run");
    expect(result.startedAt).toEqual(new Date(1718461800 * 1000));
    expect(result.endedAt).toEqual(new Date((1718461800 + 3600) * 1000));
    expect(result.raw).toBe(sampleActivity);
  });

  it("uses epoch seconds for start time", () => {
    const result = parseGarminActivity(sampleActivity);
    expect(result.startedAt).toEqual(new Date(1718461800 * 1000));
  });

  it("computes endedAt from startTimeInSeconds + durationInSeconds", () => {
    const result = parseGarminActivity(sampleActivity);
    const expectedEnd = new Date((1718461800 + 3600) * 1000);
    expect(result.endedAt).toEqual(expectedEnd);
  });

  it("handles missing optional fields", () => {
    const minimal: GarminActivitySummary = {
      activityId: 99999,
      activityName: "Walk",
      activityType: "WALKING",
      startTimeInSeconds: 1718452800,
      startTimeOffsetInSeconds: -14400,
      durationInSeconds: 1800,
      distanceInMeters: 2000,
    };
    const result = parseGarminActivity(minimal);
    expect(result.externalId).toBe("99999");
    expect(result.activityType).toBe("walking");
  });

  it("handles zero duration", () => {
    const zeroDuration = { ...sampleActivity, durationInSeconds: 0 };
    const result = parseGarminActivity(zeroDuration);
    expect(result.endedAt).toEqual(result.startedAt);
  });
});

// ============================================================
// Sleep parsing
// ============================================================

const sampleSleep: GarminSleepSummary = {
  calendarDate: "2024-06-15",
  startTimeInSeconds: 1718409600, // 2024-06-15T00:00:00Z
  startTimeOffsetInSeconds: -14400,
  durationInSeconds: 25200, // 7 hours
  deepSleepDurationInSeconds: 5400, // 90 min
  lightSleepDurationInSeconds: 10800, // 180 min
  remSleepInSeconds: 7200, // 120 min
  awakeDurationInSeconds: 1800, // 30 min
  averageSpO2Value: 96.5,
  lowestSpO2Value: 92,
  averageRespirationValue: 15.2,
  overallSleepScore: 82,
};

describe("parseGarminSleep", () => {
  it("converts seconds to minutes", () => {
    const result = parseGarminSleep(sampleSleep);
    expect(result.durationMinutes).toBe(420); // 25200 / 60
    expect(result.deepMinutes).toBe(90); // 5400 / 60
    expect(result.lightMinutes).toBe(180); // 10800 / 60
    expect(result.remMinutes).toBe(120); // 7200 / 60
    expect(result.awakeMinutes).toBe(30); // 1800 / 60
  });

  it("uses epoch seconds for start/end", () => {
    const result = parseGarminSleep(sampleSleep);
    expect(result.startedAt).toEqual(new Date(1718409600 * 1000));
    expect(result.endedAt).toEqual(new Date((1718409600 + 25200) * 1000));
  });

  it("uses calendarDate as externalId", () => {
    const result = parseGarminSleep(sampleSleep);
    expect(result.externalId).toBe("2024-06-15");
  });

  it("handles missing optional fields", () => {
    const minimalSleep: GarminSleepSummary = {
      calendarDate: "2024-06-15",
      startTimeInSeconds: 1718409600,
      startTimeOffsetInSeconds: -14400,
      durationInSeconds: 25200,
      deepSleepDurationInSeconds: 5400,
      lightSleepDurationInSeconds: 10800,
      remSleepInSeconds: 7200,
      awakeDurationInSeconds: 1800,
    };
    const result = parseGarminSleep(minimalSleep);
    expect(result.durationMinutes).toBe(420);
    expect(result.deepMinutes).toBe(90);
  });
});

// ============================================================
// Daily summary parsing
// ============================================================

const sampleDailySummary: GarminDailySummary = {
  calendarDate: "2024-06-15",
  startTimeInSeconds: 1718409600,
  startTimeOffsetInSeconds: -14400,
  durationInSeconds: 86400,
  steps: 12500,
  distanceInMeters: 9500,
  activeKilocalories: 450,
  bmrKilocalories: 1800,
  restingHeartRateInBeatsPerMinute: 58,
  maxHeartRateInBeatsPerMinute: 165,
  averageStressLevel: 35,
  maxStressLevel: 85,
  bodyBatteryChargedValue: 65,
  bodyBatteryDrainedValue: 48,
  averageSpo2: 97.1,
  lowestSpo2: 93,
  respirationAvg: 15.5,
  floorsClimbed: 12,
  moderateIntensityDurationInSeconds: 1800, // 30 min
  vigorousIntensityDurationInSeconds: 900, // 15 min
};

describe("parseGarminDailySummary", () => {
  it("maps steps", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.steps).toBe(12500);
  });

  it("converts distance from meters to km", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.distanceKm).toBeCloseTo(9.5);
  });

  it("maps active and basal calories", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.activeEnergyKcal).toBe(450);
    expect(result.basalEnergyKcal).toBe(1800);
  });

  it("maps resting heart rate", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.restingHr).toBe(58);
  });

  it("maps SpO2 average", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.spo2Avg).toBeCloseTo(97.1);
  });

  it("maps respiratory rate", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.respiratoryRateAvg).toBeCloseTo(15.5);
  });

  it("maps floors climbed to flights climbed", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.flightsClimbed).toBe(12);
  });

  it("converts intensity seconds to exercise minutes", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.exerciseMinutes).toBe(45); // (1800 + 900) / 60
  });

  it("uses calendarDate as date", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.date).toBe("2024-06-15");
  });

  it("handles missing optional fields", () => {
    const minimal: GarminDailySummary = {
      calendarDate: "2024-06-15",
      startTimeInSeconds: 1718409600,
      startTimeOffsetInSeconds: -14400,
      durationInSeconds: 86400,
      steps: 5000,
      distanceInMeters: 3800,
      activeKilocalories: 200,
      bmrKilocalories: 1700,
    };
    const result = parseGarminDailySummary(minimal);
    expect(result.steps).toBe(5000);
    expect(result.restingHr).toBeUndefined();
    expect(result.spo2Avg).toBeUndefined();
    expect(result.exerciseMinutes).toBeUndefined();
  });

  it("handles only moderate intensity seconds", () => {
    const withModerate: GarminDailySummary = {
      ...sampleDailySummary,
      moderateIntensityDurationInSeconds: 1500, // 25 min
      vigorousIntensityDurationInSeconds: undefined,
    };
    const result = parseGarminDailySummary(withModerate);
    expect(result.exerciseMinutes).toBe(25);
  });

  it("handles only vigorous intensity seconds", () => {
    const withVigorous: GarminDailySummary = {
      ...sampleDailySummary,
      moderateIntensityDurationInSeconds: undefined,
      vigorousIntensityDurationInSeconds: 1200, // 20 min
    };
    const result = parseGarminDailySummary(withVigorous);
    expect(result.exerciseMinutes).toBe(20);
  });
});

// ============================================================
// Body composition parsing
// ============================================================

const sampleBodyComp: GarminBodyComposition = {
  measurementTimeInSeconds: 1718438400, // epoch seconds
  weightInGrams: 75500,
  bmi: 23.8,
  bodyFatInPercent: 18.5,
  muscleMassInGrams: 32000,
  boneMassInGrams: 3200,
  bodyWaterInPercent: 55.2,
};

describe("parseGarminBodyComposition", () => {
  it("converts weight from grams to kg", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.weightKg).toBeCloseTo(75.5);
  });

  it("converts muscle mass from grams to kg", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.muscleMassKg).toBeCloseTo(32.0);
  });

  it("converts bone mass from grams to kg", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.boneMassKg).toBeCloseTo(3.2);
  });

  it("passes through body fat percentage", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.bodyFatPct).toBeCloseTo(18.5);
  });

  it("passes through body water percentage", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.waterPct).toBeCloseTo(55.2);
  });

  it("passes through BMI", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.bmi).toBeCloseTo(23.8);
  });

  it("uses measurementTimeInSeconds as externalId", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.externalId).toBe("1718438400");
  });

  it("uses epoch seconds for recordedAt", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.recordedAt).toEqual(new Date(1718438400 * 1000));
  });

  it("handles missing optional fields", () => {
    const minimalBodyComp: GarminBodyComposition = {
      measurementTimeInSeconds: 1718438400,
      weightInGrams: 80000,
    };
    const result = parseGarminBodyComposition(minimalBodyComp);
    expect(result.weightKg).toBeCloseTo(80.0);
    expect(result.bodyFatPct).toBeUndefined();
    expect(result.muscleMassKg).toBeUndefined();
    expect(result.boneMassKg).toBeUndefined();
    expect(result.waterPct).toBeUndefined();
    expect(result.bmi).toBeUndefined();
  });
});

// ============================================================
// Auth, validation, and client tests (merged from garmin-coverage)
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

  it("sets authorizeUrl to Garmin Connect OAuth2 authorize endpoint", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    const config = garminOAuthConfig();
    expect(config?.authorizeUrl).toBe("https://connect.garmin.com/oauth2/authorize");
  });

  it("sets tokenUrl to Garmin diauth token endpoint", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    const config = garminOAuthConfig();
    expect(config?.tokenUrl).toBe("https://diauth.garmin.com/di-oauth2-service/oauth/token");
  });
});

describe("GarminProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("always returns null (auth is per-user, checked at sync time)", () => {
    delete process.env.GARMIN_CLIENT_ID;
    delete process.env.GARMIN_USERNAME;
    delete process.env.GARMIN_PASSWORD;
    const provider = new GarminProvider();
    expect(provider.validate()).toBeNull();
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

  it("returns OAuth config when GARMIN_CLIENT_ID is set", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    process.env.GARMIN_CLIENT_SECRET = "test-secret";
    const provider = new GarminProvider();
    const setup = provider.authSetup();
    expect(setup).toBeDefined();
    expect(setup?.oauthConfig.clientId).toBe("test-id");
    expect(setup?.exchangeCode).toBeTypeOf("function");
    expect(setup?.apiBaseUrl).toBe("https://apis.garmin.com/wellness-api/rest");
  });

  it("throws when GARMIN_CLIENT_ID is missing (custom auth mode)", () => {
    delete process.env.GARMIN_CLIENT_ID;
    const provider = new GarminProvider();
    expect(() => provider.authSetup()).toThrow("GARMIN_CLIENT_ID is required");
  });
});

describe("GarminProvider — provider identity", () => {
  it("has id 'garmin'", () => {
    const provider = new GarminProvider();
    expect(provider.id).toBe("garmin");
  });

  it("has name 'Garmin Connect'", () => {
    const provider = new GarminProvider();
    expect(provider.name).toBe("Garmin Connect");
  });
});

// ============================================================
// GarminClient tests (merged from garmin-coverage and garmin-coverage-ext)
// ============================================================

describe("GarminClient — error handling", () => {
  it("throws on non-OK response from activities endpoint", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new GarminClient("bad-token", mockFetch);
    await expect(client.getActivities(0, 1000)).rejects.toThrow("Garmin API error (401)");
  });

  it("throws on non-OK response from sleep endpoint", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Server Error", { status: 500 });
    };

    const client = new GarminClient("token", mockFetch);
    await expect(client.getSleep(0, 1000)).rejects.toThrow("Garmin API error (500)");
  });

  it("throws on non-OK response from daily summaries endpoint", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Forbidden", { status: 403 });
    };

    const client = new GarminClient("token", mockFetch);
    await expect(client.getDailySummaries(0, 1000)).rejects.toThrow("Garmin API error (403)");
  });

  it("throws on non-OK response from body composition endpoint", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Not Found", { status: 404 });
    };

    const client = new GarminClient("token", mockFetch);
    await expect(client.getBodyComposition(0, 1000)).rejects.toThrow("Garmin API error (404)");
  });

  it("includes response body in error for 400 Bad Request", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Invalid date range parameter", { status: 400 });
    };

    const client = new GarminClient("token", mockFetch);
    await expect(client.getActivities(0, 1000)).rejects.toThrow("Garmin API error (400)");
    await expect(client.getActivities(0, 1000)).rejects.toThrow("Invalid date range parameter");
  });

  it("handles empty error body", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("", { status: 503 });
    };

    const client = new GarminClient("token", mockFetch);
    await expect(client.getDailySummaries(0, 1000)).rejects.toThrow("Garmin API error (503)");
  });

  it("includes error body text in thrown error message", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Rate limit exceeded - try again later", { status: 429 });
    };

    const client = new GarminClient("token", mockFetch);
    await expect(client.getActivities(0, 1000)).rejects.toThrow(
      "Rate limit exceeded - try again later",
    );
  });
});

describe("GarminClient — successful API calls", () => {
  it("getActivities sends correct query params and returns parsed data", async () => {
    const activities: GarminActivitySummary[] = [
      {
        activityId: 111,
        activityName: "Run",
        activityType: "RUNNING",
        startTimeInSeconds: 1700000000,
        startTimeOffsetInSeconds: 0,
        durationInSeconds: 1800,
        distanceInMeters: 5000,
      },
    ];

    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-token-123");
      return Response.json(activities);
    };

    const client = new GarminClient("test-token-123", mockFetch);
    const result = await client.getActivities(1000, 2000);

    expect(result).toHaveLength(1);
    expect(result[0]?.activityId).toBe(111);
    expect(capturedUrl).toContain("uploadStartTimeInSeconds=1000");
    expect(capturedUrl).toContain("uploadEndTimeInSeconds=2000");
    expect(capturedUrl).toContain("/activities");
  });

  it("getSleep sends correct query params and returns parsed data", async () => {
    const sleepData: GarminSleepSummary[] = [
      {
        calendarDate: "2026-03-01",
        startTimeInSeconds: 1772100000,
        startTimeOffsetInSeconds: 0,
        durationInSeconds: 28800,
        deepSleepDurationInSeconds: 5400,
        lightSleepDurationInSeconds: 12600,
        remSleepInSeconds: 6300,
        awakeDurationInSeconds: 4500,
      },
    ];

    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json(sleepData);
    };

    const client = new GarminClient("test-token-123", mockFetch);
    const result = await client.getSleep(5000, 6000);

    expect(result).toHaveLength(1);
    expect(result[0]?.calendarDate).toBe("2026-03-01");
    expect(capturedUrl).toContain("uploadStartTimeInSeconds=5000");
    expect(capturedUrl).toContain("uploadEndTimeInSeconds=6000");
    expect(capturedUrl).toContain("/sleep");
  });

  it("getDailySummaries sends correct query params", async () => {
    const dailies: GarminDailySummary[] = [
      {
        calendarDate: "2026-03-01",
        startTimeInSeconds: 1772100000,
        startTimeOffsetInSeconds: 0,
        durationInSeconds: 86400,
        steps: 10000,
        distanceInMeters: 8000,
        activeKilocalories: 500,
        bmrKilocalories: 1700,
      },
    ];

    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json(dailies);
    };

    const client = new GarminClient("test-token-123", mockFetch);
    const result = await client.getDailySummaries(3000, 4000);

    expect(result).toHaveLength(1);
    expect(result[0]?.steps).toBe(10000);
    expect(capturedUrl).toContain("uploadStartTimeInSeconds=3000");
    expect(capturedUrl).toContain("uploadEndTimeInSeconds=4000");
    expect(capturedUrl).toContain("/dailies");
  });

  it("getBodyComposition sends correct query params", async () => {
    const bodyComp: GarminBodyComposition[] = [
      {
        measurementTimeInSeconds: 1772100000,
        weightInGrams: 80000,
        bmi: 24.5,
      },
    ];

    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json(bodyComp);
    };

    const client = new GarminClient("test-token-123", mockFetch);
    const result = await client.getBodyComposition(7000, 8000);

    expect(result).toHaveLength(1);
    expect(result[0]?.weightInGrams).toBe(80000);
    expect(capturedUrl).toContain("uploadStartTimeInSeconds=7000");
    expect(capturedUrl).toContain("uploadEndTimeInSeconds=8000");
    expect(capturedUrl).toContain("/bodyComposition");
  });
});

describe("GarminClient — constructor defaults", () => {
  it("accepts custom fetch function", async () => {
    let fetchCalled = false;
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      fetchCalled = true;
      return Response.json([]);
    };

    const client = new GarminClient("token", mockFetch);
    await client.getActivities(0, 1000);
    expect(fetchCalled).toBe(true);
  });

  it("builds correct URL with base path for each endpoint", async () => {
    const capturedUrls: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrls.push(input.toString());
      return Response.json([]);
    };

    const client = new GarminClient("token", mockFetch);

    await client.getActivities(100, 200);
    await client.getSleep(100, 200);
    await client.getDailySummaries(100, 200);
    await client.getBodyComposition(100, 200);

    expect(capturedUrls[0]).toContain("https://apis.garmin.com/wellness-api/rest/activities");
    expect(capturedUrls[1]).toContain("https://apis.garmin.com/wellness-api/rest/sleep");
    expect(capturedUrls[2]).toContain("https://apis.garmin.com/wellness-api/rest/dailies");
    expect(capturedUrls[3]).toContain("https://apis.garmin.com/wellness-api/rest/bodyComposition");
  });
});
