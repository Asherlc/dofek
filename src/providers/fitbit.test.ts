import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import {
  type FitbitActivity,
  type FitbitDailySummary,
  FitbitProvider,
  type FitbitSleepLog,
  type FitbitWeightLog,
  mapFitbitActivityType,
  parseFitbitActivity,
  parseFitbitDailySummary,
  parseFitbitSleep,
  parseFitbitWeightLog,
} from "./fitbit.ts";
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
    () => process.env.OAUTH_REDIRECT_URI_unencrypted ?? "https://dofek.example.com/callback",
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
  };

  for (const fn of Object.values(chain)) {
    fn.mockReturnValue(chain);
  }

  const insertFn = vi.fn().mockReturnValue(chain);

  const db: SyncDatabase = {
    select: vi.fn(),
    insert: insertFn,
    delete: vi.fn(),
    execute: vi.fn(),
  };

  return Object.assign(db, chain);
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

    it("returns other for unknown activities", () => {
      expect(mapFitbitActivityType("Unknown Sport", 99999)).toBe("other");
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

      // Verify activity was inserted with correct values
      const activityValues = findValuesCall(
        db,
        (v) => v.externalId === "12345678" && v.providerId === "fitbit",
      );
      expect(activityValues.activityType).toBe("running");
      expect(activityValues.name).toBe("Run");
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

      const sleepValues = findValuesCall(
        db,
        (v) => v.externalId === "87654321" && v.providerId === "fitbit",
      );
      expect(sleepValues.durationMinutes).toBe(465);
      expect(sleepValues.efficiencyPct).toBe(92);
      expect(sleepValues.sleepType).toBe("main");
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

      const weightValues = findValuesCall(
        db,
        (v) => v.externalId === "55555" && v.providerId === "fitbit",
      );
      expect(weightValues.weightKg).toBe(82.5);
      expect(weightValues.bodyFatPct).toBe(18.5);
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
    });
  });
});
