import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import {
  activity as activityTable,
  bodyMeasurement as bodyMeasurementTable,
  dailyMetrics as dailyMetricsTable,
  sleepSession as sleepSessionTable,
} from "../db/schema.ts";
import {
  type FitbitActivity,
  FitbitClient,
  type FitbitDailySummary,
  type FitbitSleepLog,
  type FitbitWeightLog,
  fitbitActivitySchema,
  fitbitDailySummarySchema,
  fitbitSleepLogSchema,
  fitbitWeightLogSchema,
} from "./fitbit/client.ts";
import {
  mapFitbitActivityType,
  parseFitbitActivity,
  parseFitbitDailySummary,
  parseFitbitSleep,
  parseFitbitWeightLog,
} from "./fitbit/parsers.ts";
import { FitbitProvider } from "./fitbit/provider.ts";
import type { WebhookEvent } from "./types.ts";

// ============================================================
// Mock external dependencies (for sync/webhook tests)
// ============================================================

vi.mock("../db/sync-log.ts", () => ({
  withSyncLog: vi.fn(
    async (
      _db: unknown,
      _providerId: string,
      _dataType: string,
      fn: () => Promise<{ recordCount: number; result: unknown }>,
    ) => {
      const { result } = await fn();
      return result;
    },
  ),
}));

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn(async () => "fitbit"),
  loadTokens: vi.fn(async () => ({
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "activity heartrate sleep weight profile",
  })),
  saveTokens: vi.fn(async () => {}),
}));

vi.mock("../auth/oauth.ts", () => ({
  exchangeCodeForTokens: vi.fn(async () => ({
    accessToken: "exchanged-token",
    refreshToken: "exchanged-refresh",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "activity",
  })),
  getOAuthRedirectUri: vi.fn(
    () => process.env.OAUTH_REDIRECT_URI ?? "https://dofek.example.com/callback",
  ),
  buildAuthorizationUrl: vi.fn(() => "https://fitbit.com/authorize?client_id=test"),
  generateCodeVerifier: vi.fn(() => "test-verifier"),
  generateCodeChallenge: vi.fn(() => "test-challenge"),
  refreshAccessToken: vi.fn(async () => ({
    accessToken: "refreshed-token",
    refreshToken: "refreshed-refresh",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "activity",
  })),
}));

// ============================================================
// Mock DB (chainable insert pattern)
// ============================================================

function createMockDb() {
  const chain = {
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    returning: vi.fn().mockResolvedValue([{ id: "mock-activity-id" }]),
    where: vi.fn().mockResolvedValue(undefined),
  };

  for (const fn of Object.values(chain)) {
    if (!vi.isMockFunction(fn) || fn.getMockImplementation()) continue;
    fn.mockReturnValue(chain);
  }

  const insertFn = vi.fn().mockReturnValue(chain);
  const deleteFn = vi.fn().mockReturnValue(chain);

  const db: SyncDatabase = {
    select: vi.fn(),
    insert: insertFn,
    delete: deleteFn,
    execute: vi.fn(),
  };

  return Object.assign(db, chain);
}

function expectConflictTarget(
  db: ReturnType<typeof createMockDb>,
  expectedTarget: ReadonlyArray<unknown>,
): void {
  const targetMatched = db.onConflictDoUpdate.mock.calls.some((callArgs) => {
    const [arg] = callArgs;
    if (typeof arg !== "object" || arg === null || !("target" in arg)) {
      return false;
    }
    const target = Reflect.get(arg, "target");
    if (!Array.isArray(target) || target.length !== expectedTarget.length) {
      return false;
    }
    return target.every((column, index) => column === expectedTarget[index]);
  });
  expect(targetMatched).toBe(true);
}

function expectConflictSetContainsKey(
  db: ReturnType<typeof createMockDb>,
  expectedTarget: ReadonlyArray<unknown>,
  key: string,
): void {
  const setMatched = db.onConflictDoUpdate.mock.calls.some((callArgs) => {
    const [arg] = callArgs;
    if (typeof arg !== "object" || arg === null || !("target" in arg) || !("set" in arg)) {
      return false;
    }
    const target = Reflect.get(arg, "target");
    const set = Reflect.get(arg, "set");
    if (!Array.isArray(target) || target.length !== expectedTarget.length) {
      return false;
    }
    const targetMatches = target.every((column, index) => column === expectedTarget[index]);
    if (!targetMatches || typeof set !== "object" || set === null) {
      return false;
    }
    return key in set;
  });
  expect(setMatched).toBe(true);
}

function expectReasonableDuration(durationMilliseconds: number): void {
  expect(durationMilliseconds).toBeGreaterThanOrEqual(0);
  expect(durationMilliseconds).toBeLessThan(60_000);
}

function expectSchemaParseAndKeys<T extends Record<string, unknown>>(
  schema: z.ZodSchema<T>,
  input: T,
  requiredKeys: string[],
): void {
  const parsed: Record<string, unknown> = schema.parse(input);
  for (const key of requiredKeys) {
    expect(key in parsed).toBe(true);
    expect(parsed[key]).not.toBeUndefined();
  }
}

const recordSchema = z.record(z.string(), z.unknown());

function findValuesCall(
  db: ReturnType<typeof createMockDb>,
  predicate: (val: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  for (const c of db.values.mock.calls) {
    const parsed = recordSchema.safeParse(c[0]);
    if (parsed.success && predicate(parsed.data)) return parsed.data;
  }
  throw new Error("No matching values call found");
}

// ============================================================
// Mock fetch for Fitbit API
// ============================================================

interface MockFitbitApiData {
  activities?: FitbitActivity[];
  sleep?: FitbitSleepLog[];
  dailySummary?: FitbitDailySummary;
  weight?: FitbitWeightLog[];
}

function createMockApiFetch(data: MockFitbitApiData = {}): typeof globalThis.fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = input.toString();

    if (urlStr.includes("/activities/list.json")) {
      return Response.json({
        activities: data.activities ?? [],
        pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
      });
    }
    if (urlStr.includes("/sleep/list.json")) {
      return Response.json({
        sleep: data.sleep ?? [],
        pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
      });
    }
    if (urlStr.includes("/activities/date/")) {
      return Response.json(
        data.dailySummary ?? {
          summary: {
            steps: 0,
            caloriesOut: 0,
            activeScore: 0,
            activityCalories: 0,
            distances: [],
            fairlyActiveMinutes: 0,
            veryActiveMinutes: 0,
            lightlyActiveMinutes: 0,
            sedentaryMinutes: 0,
          },
        },
      );
    }
    if (urlStr.includes("/body/log/weight/date/")) {
      return Response.json({ weight: data.weight ?? [] });
    }
    if (urlStr.endsWith(".tcx")) {
      return new Response("<TrainingCenterDatabase></TrainingCenterDatabase>", {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    }

    return new Response("Not found", { status: 404 });
  };
}

// ============================================================
// Sample API responses
// ============================================================

const sampleActivity: FitbitActivity = {
  logId: 12345678,
  activityName: "Run",
  activityTypeId: 90009,
  startTime: "08:30",
  activeDuration: 3600000, // 60 min in ms
  calories: 450,
  distance: 10.5,
  distanceUnit: "Kilometer",
  steps: 8500,
  averageHeartRate: 155,
  heartRateZones: [
    { name: "Out of Range", min: 30, max: 100, minutes: 2 },
    { name: "Fat Burn", min: 100, max: 140, minutes: 10 },
    { name: "Cardio", min: 140, max: 170, minutes: 35 },
    { name: "Peak", min: 170, max: 220, minutes: 13 },
  ],
  logType: "auto_detected",
  startDate: "2026-03-01",
  tcxLink: "https://api.fitbit.com/1/user/-/activities/12345678.tcx",
};

const sampleSleep: FitbitSleepLog = {
  logId: 87654321,
  dateOfSleep: "2026-03-01",
  startTime: "2026-02-28T23:15:00.000",
  endTime: "2026-03-01T07:00:00.000",
  duration: 27900000, // 7h 45m in ms
  efficiency: 92,
  isMainSleep: true,
  type: "stages",
  levels: {
    summary: {
      deep: { count: 4, minutes: 85, thirtyDayAvgMinutes: 80 },
      light: { count: 28, minutes: 210, thirtyDayAvgMinutes: 200 },
      rem: { count: 6, minutes: 95, thirtyDayAvgMinutes: 90 },
      wake: { count: 30, minutes: 35, thirtyDayAvgMinutes: 40 },
    },
  },
};

const sampleDailySummary: FitbitDailySummary = {
  summary: {
    steps: 12345,
    caloriesOut: 2800,
    activeScore: -1,
    activityCalories: 1200,
    restingHeartRate: 58,
    distances: [
      { activity: "total", distance: 9.5 },
      { activity: "tracker", distance: 9.5 },
    ],
    fairlyActiveMinutes: 25,
    veryActiveMinutes: 45,
    lightlyActiveMinutes: 180,
    sedentaryMinutes: 720,
    floors: 12,
  },
};

const sampleWeightLog: FitbitWeightLog = {
  logId: 55555,
  weight: 82.5,
  bmi: 24.8,
  fat: 18.5,
  date: "2026-03-01",
  time: "07:30:00",
};

// ============================================================
// Tests
// ============================================================

describe("Fitbit Provider", () => {
  describe("mapFitbitActivityType", () => {
    it("maps running activities", () => {
      expect(mapFitbitActivityType("Run", 90009)).toBe("running");
      expect(mapFitbitActivityType("Treadmill", 90009)).toBe("running");
      expect(mapFitbitActivityType("Outdoor Run", 90009)).toBe("running");
    });

    it("maps cycling activities", () => {
      expect(mapFitbitActivityType("Bike", 90001)).toBe("cycling");
      expect(mapFitbitActivityType("Outdoor Bike", 90001)).toBe("cycling");
      expect(mapFitbitActivityType("Spinning", 15000)).toBe("cycling");
    });

    it("maps walking activities", () => {
      expect(mapFitbitActivityType("Walk", 90013)).toBe("walking");
      expect(mapFitbitActivityType("Outdoor Walk", 90013)).toBe("walking");
    });

    it("maps swimming activities", () => {
      expect(mapFitbitActivityType("Swim", 90024)).toBe("swimming");
      expect(mapFitbitActivityType("Swimming", 90024)).toBe("swimming");
    });

    it("maps hiking activities", () => {
      expect(mapFitbitActivityType("Hike", 90012)).toBe("hiking");
      expect(mapFitbitActivityType("Hiking", 90012)).toBe("hiking");
    });

    it("maps yoga activities", () => {
      expect(mapFitbitActivityType("Yoga", 52001)).toBe("yoga");
    });

    it("maps strength/weight training", () => {
      expect(mapFitbitActivityType("Weights", 2030)).toBe("strength");
      expect(mapFitbitActivityType("Weight Training", 2030)).toBe("strength");
    });

    it("maps elliptical activities", () => {
      expect(mapFitbitActivityType("Elliptical", 90017)).toBe("elliptical");
    });

    it("maps rowing activities", () => {
      expect(mapFitbitActivityType("Rowing", 90019)).toBe("rowing");
      expect(mapFitbitActivityType("Row", 90019)).toBe("rowing");
    });

    it("returns other for unknown activities", () => {
      expect(mapFitbitActivityType("Unknown Sport", 99999)).toBe("other");
    });
  });

  describe("Fitbit API schemas", () => {
    it("accepts valid activity, sleep, daily summary, and weight objects", () => {
      expectSchemaParseAndKeys(fitbitActivitySchema, sampleActivity, [
        "logId",
        "activityName",
        "activityTypeId",
      ]);
      expectSchemaParseAndKeys(fitbitSleepLogSchema, sampleSleep, ["logId", "dateOfSleep", "type"]);
      expectSchemaParseAndKeys(fitbitDailySummarySchema, sampleDailySummary, ["summary"]);
      expectSchemaParseAndKeys(fitbitWeightLogSchema, sampleWeightLog, ["logId", "weight", "date"]);
    });

    it("rejects malformed data and invalid enum values", () => {
      expect(fitbitActivitySchema.safeParse({}).success).toBe(false);
      expect(
        fitbitActivitySchema.safeParse({
          ...sampleActivity,
          heartRateZones: [{ min: 120, max: 150, minutes: 20 }],
        }).success,
      ).toBe(false);
      expect(fitbitSleepLogSchema.safeParse({ ...sampleSleep, type: "nap" }).success).toBe(false);
      expect(
        fitbitDailySummarySchema.safeParse({
          summary: { ...sampleDailySummary.summary, distances: [{ distance: 5 }] },
        }).success,
      ).toBe(false);
      expect(fitbitWeightLogSchema.safeParse({ ...sampleWeightLog, weight: "82.5" }).success).toBe(
        false,
      );
    });
  });

  describe("FitbitClient schema validation", () => {
    it("rejects malformed list responses from activity/sleep/weight endpoints", async () => {
      const mockFetch: typeof globalThis.fetch = async (
        input: RequestInfo | URL,
      ): Promise<Response> => {
        const url = input.toString();
        if (url.includes("/activities/list.json")) {
          return Response.json({ activities: [sampleActivity] });
        }
        if (url.includes("/sleep/list.json")) {
          return Response.json({ sleep: [sampleSleep] });
        }
        if (url.includes("/body/log/weight/date/")) {
          return Response.json({});
        }
        return new Response("Not found", { status: 404 });
      };

      const client = new FitbitClient("test-token", mockFetch);
      await expect(client.getActivities("2026-03-01", 0)).rejects.toThrow();
      await expect(client.getSleepLogs("2026-03-01", 0)).rejects.toThrow();
      await expect(client.getWeightLogs("2026-03-01")).rejects.toThrow();
    });
  });

  describe("parseFitbitActivity", () => {
    it("maps activity fields correctly", () => {
      const result = parseFitbitActivity(sampleActivity);

      expect(result.externalId).toBe("12345678");
      expect(result.activityType).toBe("running");
      expect(result.name).toBe("Run");
      expect(result.startedAt).toEqual(new Date("2026-03-01T08:30:00"));
      expect(result.calories).toBe(450);
      expect(result.distanceKm).toBe(10.5);
      expect(result.steps).toBe(8500);
      expect(result.averageHeartRate).toBe(155);
    });

    it("computes endedAt from startedAt + activeDuration", () => {
      const result = parseFitbitActivity(sampleActivity);
      const expectedEnd = new Date(result.startedAt.getTime() + 3600000);
      expect(result.endedAt).toEqual(expectedEnd);
    });

    it("handles missing optional fields", () => {
      const minimal: FitbitActivity = {
        logId: 99999,
        activityName: "Sport",
        activityTypeId: 99999,
        startTime: "10:00",
        activeDuration: 1800000,
        calories: 200,
        distanceUnit: "",
        logType: "manual",
        startDate: "2026-03-01",
      };

      const result = parseFitbitActivity(minimal);

      expect(result.externalId).toBe("99999");
      expect(result.activityType).toBe("other");
      expect(result.distanceKm).toBeUndefined();
      expect(result.steps).toBeUndefined();
      expect(result.averageHeartRate).toBeUndefined();
      expect(result.heartRateZones).toBeUndefined();
    });

    it("preserves heart rate zones", () => {
      const result = parseFitbitActivity(sampleActivity);
      expect(result.heartRateZones).toHaveLength(4);
      expect(result.heartRateZones?.[2]).toEqual({
        name: "Cardio",
        min: 140,
        max: 170,
        minutes: 35,
      });
    });
  });

  describe("parseFitbitSleep", () => {
    it("maps sleep fields correctly", () => {
      const result = parseFitbitSleep(sampleSleep);

      expect(result.externalId).toBe("87654321");
      expect(result.startedAt).toEqual(new Date("2026-02-28T23:15:00.000"));
      expect(result.endedAt).toEqual(new Date("2026-03-01T07:00:00.000"));
      expect(result.durationMinutes).toBe(465); // 27900000 / 60000
      expect(result.efficiencyPct).toBe(92);
      expect(result.isNap).toBe(false);
    });

    it("maps stage summary minutes", () => {
      const result = parseFitbitSleep(sampleSleep);

      expect(result.deepMinutes).toBe(85);
      expect(result.lightMinutes).toBe(210);
      expect(result.remMinutes).toBe(95);
      expect(result.awakeMinutes).toBe(35);
    });

    it("handles classic sleep type (no stage breakdown)", () => {
      const classicSleep: FitbitSleepLog = {
        ...sampleSleep,
        type: "classic",
        levels: {
          summary: {},
        },
      };

      const result = parseFitbitSleep(classicSleep);

      expect(result.deepMinutes).toBeUndefined();
      expect(result.lightMinutes).toBeUndefined();
      expect(result.remMinutes).toBeUndefined();
      expect(result.awakeMinutes).toBeUndefined();
    });

    it("identifies naps", () => {
      const napSleep: FitbitSleepLog = {
        ...sampleSleep,
        isMainSleep: false,
      };

      const result = parseFitbitSleep(napSleep);
      expect(result.isNap).toBe(true);
    });
  });

  describe("parseFitbitDailySummary", () => {
    it("maps daily summary fields", () => {
      const result = parseFitbitDailySummary("2026-03-01", sampleDailySummary);

      expect(result.date).toBe("2026-03-01");
      expect(result.steps).toBe(12345);
      expect(result.restingHr).toBe(58);
      expect(result.activeEnergyKcal).toBe(1200);
      expect(result.exerciseMinutes).toBe(70); // fairlyActive + veryActive
      expect(result.flightsClimbed).toBe(12);
    });

    it("extracts total distance from distances array", () => {
      const result = parseFitbitDailySummary("2026-03-01", sampleDailySummary);
      expect(result.distanceKm).toBe(9.5);
    });

    it("handles missing restingHeartRate", () => {
      const noRhr: FitbitDailySummary = {
        summary: {
          ...sampleDailySummary.summary,
          restingHeartRate: undefined,
        },
      };

      const result = parseFitbitDailySummary("2026-03-01", noRhr);
      expect(result.restingHr).toBeUndefined();
    });

    it("handles missing floors", () => {
      const noFloors: FitbitDailySummary = {
        summary: {
          ...sampleDailySummary.summary,
          floors: undefined,
        },
      };

      const result = parseFitbitDailySummary("2026-03-01", noFloors);
      expect(result.flightsClimbed).toBeUndefined();
    });

    it("returns undefined distance when no total in distances array", () => {
      const noTotal: FitbitDailySummary = {
        summary: {
          ...sampleDailySummary.summary,
          distances: [{ activity: "tracker", distance: 9.5 }],
        },
      };

      const result = parseFitbitDailySummary("2026-03-01", noTotal);
      expect(result.distanceKm).toBeUndefined();
    });
  });

  describe("parseFitbitWeightLog", () => {
    it("maps weight log fields", () => {
      const result = parseFitbitWeightLog(sampleWeightLog);

      expect(result.externalId).toBe("55555");
      expect(result.weightKg).toBe(82.5);
      expect(result.bodyFatPct).toBe(18.5);
      expect(result.recordedAt).toEqual(new Date("2026-03-01T07:30:00"));
    });

    it("handles missing body fat", () => {
      const noFat: FitbitWeightLog = {
        ...sampleWeightLog,
        fat: undefined,
      };

      const result = parseFitbitWeightLog(noFat);
      expect(result.weightKg).toBe(82.5);
      expect(result.bodyFatPct).toBeUndefined();
    });
  });
});

// ============================================================
// FitbitProvider webhook tests
// ============================================================

describe("FitbitProvider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function setupEnv() {
    process.env.FITBIT_CLIENT_ID = "test-client-id";
    process.env.FITBIT_CLIENT_SECRET = "test-client-secret";
  }

  describe("properties", () => {
    it("has correct id, name, and webhookScope", () => {
      const provider = new FitbitProvider();
      expect(provider.id).toBe("fitbit");
      expect(provider.name).toBe("Fitbit");
      expect(provider.webhookScope).toBe("app");
    });
  });

  describe("validate()", () => {
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

    it("returns null when both env vars are set", () => {
      setupEnv();
      const provider = new FitbitProvider();
      expect(provider.validate()).toBeNull();
    });
  });

  describe("registerWebhook()", () => {
    it("returns static subscription ID and signing secret", async () => {
      const provider = new FitbitProvider();
      const result = await provider.registerWebhook(
        "https://example.com/webhook",
        "my-verify-token",
      );

      expect(result.subscriptionId).toBe("fitbit-app-subscription");
      expect(result.signingSecret).toBe("my-verify-token");
      expect(result.expiresAt).toBeUndefined();
    });
  });

  describe("unregisterWebhook()", () => {
    it("completes without error (no-op)", async () => {
      const provider = new FitbitProvider();
      await expect(provider.unregisterWebhook("fitbit-app-subscription")).resolves.toBeUndefined();
    });
  });

  describe("verifyWebhookSignature()", () => {
    it("returns true for valid HMAC-SHA1 signature", () => {
      const provider = new FitbitProvider();
      const signingSecret = "my-secret";
      const body = Buffer.from('{"test": true}');

      const hmac = createHmac("sha1", `${signingSecret}&`);
      hmac.update(body);
      const expectedSignature = hmac.digest("base64");

      const result = provider.verifyWebhookSignature(
        body,
        { "x-fitbit-signature": expectedSignature },
        signingSecret,
      );

      expect(result).toBe(true);
    });

    it("returns false for invalid signature", () => {
      const provider = new FitbitProvider();
      const body = Buffer.from('{"test": true}');

      const result = provider.verifyWebhookSignature(
        body,
        { "x-fitbit-signature": "invalid-signature" },
        "my-secret",
      );

      expect(result).toBe(false);
    });

    it("returns false when x-fitbit-signature header is missing", () => {
      const provider = new FitbitProvider();
      const body = Buffer.from('{"test": true}');

      const result = provider.verifyWebhookSignature(body, {}, "my-secret");

      expect(result).toBe(false);
    });

    it("returns false when x-fitbit-signature is not a string", () => {
      const provider = new FitbitProvider();
      const body = Buffer.from('{"test": true}');

      const result = provider.verifyWebhookSignature(
        body,
        { "x-fitbit-signature": ["a", "b"] },
        "my-secret",
      );

      expect(result).toBe(false);
    });
  });

  describe("parseWebhookPayload()", () => {
    it("parses array of notification objects", () => {
      const provider = new FitbitProvider();
      const payload = [
        {
          collectionType: "activities",
          ownerId: "ABC123",
          date: "2026-03-01",
          subscriptionId: "sub-1",
        },
        {
          collectionType: "sleep",
          ownerId: "ABC123",
          date: "2026-03-02",
        },
      ];

      const events = provider.parseWebhookPayload(payload);

      expect(events).toHaveLength(2);
      expect(events[0]?.ownerExternalId).toBe("ABC123");
      expect(events[0]?.eventType).toBe("update");
      expect(events[0]?.objectType).toBe("activities");
      expect(events[0]?.metadata).toEqual({ date: "2026-03-01" });

      expect(events[1]?.objectType).toBe("sleep");
      expect(events[1]?.metadata).toEqual({ date: "2026-03-02" });
    });

    it("returns empty array for non-array payload", () => {
      const provider = new FitbitProvider();
      expect(provider.parseWebhookPayload({ not: "an-array" })).toEqual([]);
      expect(provider.parseWebhookPayload(null)).toEqual([]);
      expect(provider.parseWebhookPayload("string")).toEqual([]);
    });

    it("filters out invalid items in array", () => {
      const provider = new FitbitProvider();
      const payload = [
        { collectionType: "activities", ownerId: "ABC123" },
        { invalid: true },
        "not-an-object",
      ];

      const events = provider.parseWebhookPayload(payload);

      expect(events).toHaveLength(1);
      expect(events[0]?.objectType).toBe("activities");
    });

    it("omits metadata when date is absent", () => {
      const provider = new FitbitProvider();
      const payload = [{ collectionType: "body", ownerId: "XYZ" }];

      const events = provider.parseWebhookPayload(payload);

      expect(events).toHaveLength(1);
      expect(events[0]?.metadata).toBeUndefined();
    });
  });

  describe("handleValidationChallenge()", () => {
    it("returns empty string when verify matches verifyToken", () => {
      const provider = new FitbitProvider();
      const result = provider.handleValidationChallenge({ verify: "my-token" }, "my-token");
      expect(result).toBe("");
    });

    it("returns null when verify does not match", () => {
      const provider = new FitbitProvider();
      const result = provider.handleValidationChallenge({ verify: "wrong-token" }, "my-token");
      expect(result).toBeNull();
    });

    it("returns null when verify param is missing", () => {
      const provider = new FitbitProvider();
      const result = provider.handleValidationChallenge({}, "my-token");
      expect(result).toBeNull();
    });
  });

  describe("sync()", () => {
    it("syncs activities, sleep, daily metrics, and body measurements with user-scoped targets", async () => {
      setupEnv();
      const mockFetch = createMockApiFetch({
        activities: [sampleActivity],
        sleep: [sampleSleep],
        dailySummary: sampleDailySummary,
        weight: [sampleWeightLog],
      });
      const provider = new FitbitProvider(mockFetch);
      const db = createMockDb();

      const since = new Date();
      since.setUTCHours(0, 0, 0, 0);
      const result = await provider.sync(db, since);

      expect(result.provider).toBe("fitbit");
      expect(result.errors).toHaveLength(0);
      expect(result.recordsSynced).toBeGreaterThanOrEqual(4);
      expectReasonableDuration(result.duration);

      expectConflictTarget(db, [
        activityTable.userId,
        activityTable.providerId,
        activityTable.externalId,
      ]);
      expectConflictSetContainsKey(
        db,
        [activityTable.userId, activityTable.providerId, activityTable.externalId],
        "activityType",
      );
      expectConflictTarget(db, [
        sleepSessionTable.userId,
        sleepSessionTable.providerId,
        sleepSessionTable.externalId,
      ]);
      expectConflictSetContainsKey(
        db,
        [sleepSessionTable.userId, sleepSessionTable.providerId, sleepSessionTable.externalId],
        "durationMinutes",
      );
      expectConflictTarget(db, [
        dailyMetricsTable.userId,
        dailyMetricsTable.date,
        dailyMetricsTable.providerId,
        dailyMetricsTable.sourceName,
      ]);
      expectConflictSetContainsKey(
        db,
        [
          dailyMetricsTable.userId,
          dailyMetricsTable.date,
          dailyMetricsTable.providerId,
          dailyMetricsTable.sourceName,
        ],
        "steps",
      );
      expectConflictTarget(db, [
        bodyMeasurementTable.userId,
        bodyMeasurementTable.providerId,
        bodyMeasurementTable.externalId,
      ]);
      expectConflictSetContainsKey(
        db,
        [
          bodyMeasurementTable.userId,
          bodyMeasurementTable.providerId,
          bodyMeasurementTable.externalId,
        ],
        "weightKg",
      );
    });

    it("captures per-record insert errors without aborting the whole sync", async () => {
      setupEnv();
      const mockFetch = createMockApiFetch({ activities: [sampleActivity] });
      const provider = new FitbitProvider(mockFetch);
      const db = createMockDb();
      db.onConflictDoUpdate.mockImplementationOnce(() => {
        throw new Error("insert failed");
      });

      const since = new Date();
      since.setUTCHours(0, 0, 0, 0);
      const result = await provider.sync(db, since);

      expect(result.provider).toBe("fitbit");
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors.some((error) => error.externalId === "12345678")).toBe(true);
      expectReasonableDuration(result.duration);
    });

    it("includes the current day in daily summary and weight sync loops", async () => {
      setupEnv();
      vi.useFakeTimers({ now: new Date("2026-03-01T12:00:00Z") });

      const provider = new FitbitProvider(
        createMockApiFetch({
          activities: [],
          sleep: [],
          dailySummary: sampleDailySummary,
          weight: [sampleWeightLog],
        }),
      );
      const db = createMockDb();

      const result = await provider.sync(db, new Date("2026-03-01T00:00:00Z"));
      vi.useRealTimers();

      expect(result.errors).toHaveLength(0);
      expect(result.recordsSynced).toBeGreaterThanOrEqual(2);

      const dailyRow = findValuesCall(
        db,
        (value) => value.providerId === "fitbit" && value.date === "2026-03-01",
      );
      expect(dailyRow.steps).toBe(12345);

      const weightRow = findValuesCall(
        db,
        (value) => value.providerId === "fitbit" && value.externalId === "55555",
      );
      expect(weightRow.weightKg).toBe(82.5);
    });

    it("paginates activity sync by increasing offset", async () => {
      setupEnv();
      vi.useFakeTimers({ now: new Date("2026-03-01T12:00:00Z") });

      const firstActivity: FitbitActivity = sampleActivity;
      const secondActivity: FitbitActivity = {
        ...sampleActivity,
        logId: 12345679,
        startTime: "09:30",
      };
      const seenOffsets: number[] = [];

      const mockFetch: typeof globalThis.fetch = async (
        input: RequestInfo | URL,
      ): Promise<Response> => {
        const url = input.toString();
        if (url.includes("/activities/list.json")) {
          const offsetMatch = url.match(/[?&]offset=(\d+)/);
          const offset = offsetMatch?.[1] ? Number(offsetMatch[1]) : 0;
          seenOffsets.push(offset);
          if (offset === 0) {
            return Response.json({
              activities: [firstActivity],
              pagination: { next: "/next", previous: "", limit: 1, offset: 0, sort: "asc" },
            });
          }
          return Response.json({
            activities: [secondActivity],
            pagination: { next: "", previous: "", limit: 1, offset: 1, sort: "asc" },
          });
        }
        if (url.includes("/sleep/list.json")) {
          return Response.json({
            sleep: [],
            pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
          });
        }
        if (url.includes("/activities/date/")) {
          return Response.json(sampleDailySummary);
        }
        if (url.includes("/body/log/weight/date/")) {
          return Response.json({ weight: [] });
        }
        if (url.endsWith(".tcx")) {
          return new Response("<TrainingCenterDatabase></TrainingCenterDatabase>", {
            status: 200,
          });
        }
        return new Response("Not found", { status: 404 });
      };

      const provider = new FitbitProvider(mockFetch);
      const db = createMockDb();
      const result = await provider.sync(db, new Date("2026-03-01T00:00:00Z"));
      vi.useRealTimers();

      expect(result.errors).toHaveLength(0);
      expect(seenOffsets).toEqual([0, 1]);
      expect(findValuesCall(db, (value) => value.externalId === "12345678").name).toBe("Run");
      expect(findValuesCall(db, (value) => value.externalId === "12345679").name).toBe("Run");
      expectReasonableDuration(result.duration);
    });
  });

  describe("syncWebhookEvent()", () => {
    it("syncs activities when objectType is activities", async () => {
      setupEnv();
      const mockFetch = createMockApiFetch({
        activities: [sampleActivity],
        dailySummary: sampleDailySummary,
      });
      const provider = new FitbitProvider(mockFetch);
      const db = createMockDb();

      const event: WebhookEvent = {
        ownerExternalId: "USER1",
        eventType: "update",
        objectType: "activities",
        metadata: { date: "2026-03-01" },
      };

      const result = await provider.syncWebhookEvent(db, event);

      expect(result.provider).toBe("fitbit");
      expect(result.errors).toHaveLength(0);
      // Should sync 1 activity + 1 daily metrics
      expect(result.recordsSynced).toBe(2);
      expectReasonableDuration(result.duration);

      // Verify activity was inserted with correct values
      const activityValues = findValuesCall(
        db,
        (v) => v.externalId === "12345678" && v.providerId === "fitbit",
      );
      expect(activityValues.activityType).toBe("running");
      expect(activityValues.name).toBe("Run");
      expectConflictTarget(db, [
        activityTable.userId,
        activityTable.providerId,
        activityTable.externalId,
      ]);
      expectConflictSetContainsKey(
        db,
        [activityTable.userId, activityTable.providerId, activityTable.externalId],
        "activityType",
      );
      expectConflictTarget(db, [
        dailyMetricsTable.userId,
        dailyMetricsTable.date,
        dailyMetricsTable.providerId,
        dailyMetricsTable.sourceName,
      ]);
      expectConflictSetContainsKey(
        db,
        [
          dailyMetricsTable.userId,
          dailyMetricsTable.date,
          dailyMetricsTable.providerId,
          dailyMetricsTable.sourceName,
        ],
        "steps",
      );
    });

    it("syncs sleep when objectType is sleep", async () => {
      setupEnv();
      const mockFetch = createMockApiFetch({ sleep: [sampleSleep] });
      const provider = new FitbitProvider(mockFetch);
      const db = createMockDb();

      const event: WebhookEvent = {
        ownerExternalId: "USER1",
        eventType: "update",
        objectType: "sleep",
        metadata: { date: "2026-03-01" },
      };

      const result = await provider.syncWebhookEvent(db, event);

      expect(result.provider).toBe("fitbit");
      expect(result.errors).toHaveLength(0);
      expect(result.recordsSynced).toBe(1);
      expectReasonableDuration(result.duration);

      const sleepValues = findValuesCall(
        db,
        (v) => v.externalId === "87654321" && v.providerId === "fitbit",
      );
      expect(sleepValues.durationMinutes).toBe(465);
      expect(sleepValues.efficiencyPct).toBe(92);
      expect(sleepValues.sleepType).toBe("main");
      expectConflictTarget(db, [
        sleepSessionTable.userId,
        sleepSessionTable.providerId,
        sleepSessionTable.externalId,
      ]);
      expectConflictSetContainsKey(
        db,
        [sleepSessionTable.userId, sleepSessionTable.providerId, sleepSessionTable.externalId],
        "sleepType",
      );
    });

    it("syncs body measurements when objectType is body", async () => {
      setupEnv();
      const mockFetch = createMockApiFetch({ weight: [sampleWeightLog] });
      const provider = new FitbitProvider(mockFetch);
      const db = createMockDb();

      const event: WebhookEvent = {
        ownerExternalId: "USER1",
        eventType: "update",
        objectType: "body",
        metadata: { date: "2026-03-01" },
      };

      const result = await provider.syncWebhookEvent(db, event);

      expect(result.provider).toBe("fitbit");
      expect(result.errors).toHaveLength(0);
      expect(result.recordsSynced).toBe(1);
      expectReasonableDuration(result.duration);

      const weightValues = findValuesCall(
        db,
        (v) => v.externalId === "55555" && v.providerId === "fitbit",
      );
      expect(weightValues.weightKg).toBe(82.5);
      expect(weightValues.bodyFatPct).toBe(18.5);
      expectConflictTarget(db, [
        bodyMeasurementTable.userId,
        bodyMeasurementTable.providerId,
        bodyMeasurementTable.externalId,
      ]);
      expectConflictSetContainsKey(
        db,
        [
          bodyMeasurementTable.userId,
          bodyMeasurementTable.providerId,
          bodyMeasurementTable.externalId,
        ],
        "weightKg",
      );
    });

    it("returns empty result for unknown objectType", async () => {
      setupEnv();
      const mockFetch = createMockApiFetch();
      const provider = new FitbitProvider(mockFetch);
      const db = createMockDb();

      const event: WebhookEvent = {
        ownerExternalId: "USER1",
        eventType: "update",
        objectType: "unknown_type",
      };

      const result = await provider.syncWebhookEvent(db, event);

      expect(result.provider).toBe("fitbit");
      expect(result.recordsSynced).toBe(0);
      expect(result.errors).toHaveLength(0);
      expectReasonableDuration(result.duration);
    });

    it("uses current date when event has no date metadata", async () => {
      setupEnv();
      const mockFetch = createMockApiFetch({ activities: [] });
      const provider = new FitbitProvider(mockFetch);
      const db = createMockDb();

      const event: WebhookEvent = {
        ownerExternalId: "USER1",
        eventType: "update",
        objectType: "activities",
        // no metadata.date
      };

      const result = await provider.syncWebhookEvent(db, event);

      expect(result.provider).toBe("fitbit");
      expect(result.errors).toHaveLength(0);
      expectReasonableDuration(result.duration);
    });

    it("returns error when token resolution fails", async () => {
      setupEnv();
      // Make token loading fail by mocking loadTokens to return null
      const { loadTokens } = await import("../db/tokens.ts");
      vi.mocked(loadTokens).mockResolvedValueOnce(null);

      const mockFetch = createMockApiFetch();
      const provider = new FitbitProvider(mockFetch);
      const db = createMockDb();

      const event: WebhookEvent = {
        ownerExternalId: "USER1",
        eventType: "update",
        objectType: "activities",
      };

      const result = await provider.syncWebhookEvent(db, event);

      expect(result.provider).toBe("fitbit");
      expect(result.recordsSynced).toBe(0);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors[0]?.message).toContain("No OAuth tokens found for Fitbit");
      expectReasonableDuration(result.duration);
    });
  });
});
