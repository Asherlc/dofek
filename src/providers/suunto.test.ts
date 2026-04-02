import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mapSuuntoActivityType,
  parseSuuntoWorkout,
  SuuntoProvider,
  suuntoOAuthConfig,
} from "./suunto.ts";

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

describe("mapSuuntoActivityType", () => {
  it("maps all known activity types", () => {
    expect(mapSuuntoActivityType(2)).toBe("running");
    expect(mapSuuntoActivityType(3)).toBe("cycling");
    expect(mapSuuntoActivityType(4)).toBe("cross_country_skiing");
    expect(mapSuuntoActivityType(11)).toBe("walking");
    expect(mapSuuntoActivityType(12)).toBe("hiking");
    expect(mapSuuntoActivityType(14)).toBe("strength");
    expect(mapSuuntoActivityType(23)).toBe("yoga");
    expect(mapSuuntoActivityType(27)).toBe("swimming");
    expect(mapSuuntoActivityType(67)).toBe("trail_running");
    expect(mapSuuntoActivityType(69)).toBe("rowing");
    expect(mapSuuntoActivityType(82)).toBe("virtual_cycling");
    expect(mapSuuntoActivityType(83)).toBe("running");
    expect(mapSuuntoActivityType(1)).toBe("other");
    expect(mapSuuntoActivityType(5)).toBe("other");
  });

  it("returns other for unknown", () => {
    expect(mapSuuntoActivityType(999)).toBe("other");
  });
});

describe("parseSuuntoWorkout", () => {
  it("parses a workout with all fields", () => {
    const workout = {
      workoutKey: "suunto-w-123",
      activityId: 3,
      workoutName: "Morning Ride",
      startTime: 1709290800000,
      stopTime: 1709294400000,
      totalTime: 3600,
      totalDistance: 30000,
      totalAscent: 300,
      totalDescent: 280,
      avgSpeed: 8.33,
      maxSpeed: 12.0,
      energyConsumption: 700,
      stepCount: 0,
      hrdata: { workoutAvgHR: 145, workoutMaxHR: 175 },
    };

    const parsed = parseSuuntoWorkout(workout);
    expect(parsed.externalId).toBe("suunto-w-123");
    expect(parsed.activityType).toBe("cycling");
    expect(parsed.name).toBe("Morning Ride");
    expect(parsed.startedAt).toEqual(new Date(1709290800000));
    expect(parsed.endedAt).toEqual(new Date(1709294400000));
    expect(parsed.raw.totalDistance).toBe(30000);
    expect(parsed.raw.avgHeartRate).toBe(145);
    expect(parsed.raw.maxHeartRate).toBe(175);
    expect(parsed.raw.calories).toBe(700);
    expect(parsed.raw.steps).toBe(0);
  });

  it("generates name when workoutName is missing", () => {
    const workout = {
      workoutKey: "w-min",
      activityId: 2,
      startTime: 1709290800000,
      stopTime: 1709292600000,
      totalTime: 1800,
      totalDistance: 5000,
      totalAscent: 50,
      totalDescent: 50,
      avgSpeed: 2.78,
      maxSpeed: 3.5,
      energyConsumption: 300,
      stepCount: 3000,
    };

    const parsed = parseSuuntoWorkout(workout);
    expect(parsed.name).toBe("Suunto running");
    expect(parsed.raw.avgHeartRate).toBeUndefined();
    expect(parsed.raw.maxHeartRate).toBeUndefined();
  });
});

describe("suuntoOAuthConfig", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when missing", () => {
    delete process.env.SUUNTO_CLIENT_ID;
    delete process.env.SUUNTO_CLIENT_SECRET;
    expect(suuntoOAuthConfig()).toBeNull();
  });

  it("returns config when set", () => {
    process.env.SUUNTO_CLIENT_ID = "id";
    process.env.SUUNTO_CLIENT_SECRET = "secret";
    const config = suuntoOAuthConfig();
    expect(config?.clientId).toBe("id");
    expect(config?.tokenAuthMethod).toBe("basic");
  });
});

describe("SuuntoProvider", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("validate returns errors for missing env vars", () => {
    delete process.env.SUUNTO_CLIENT_ID;
    delete process.env.SUUNTO_CLIENT_SECRET;
    delete process.env.SUUNTO_SUBSCRIPTION_KEY;
    expect(new SuuntoProvider().validate()).toContain("SUUNTO_CLIENT_ID");
    process.env.SUUNTO_CLIENT_ID = "id";
    expect(new SuuntoProvider().validate()).toContain("SUUNTO_CLIENT_SECRET");
    process.env.SUUNTO_CLIENT_SECRET = "secret";
    expect(new SuuntoProvider().validate()).toContain("SUUNTO_SUBSCRIPTION_KEY");
    process.env.SUUNTO_SUBSCRIPTION_KEY = "key";
    expect(new SuuntoProvider().validate()).toBeNull();
  });

  it("sync returns error when no tokens", async () => {
    process.env.SUUNTO_CLIENT_ID = "id";
    process.env.SUUNTO_CLIENT_SECRET = "secret";
    process.env.SUUNTO_SUBSCRIPTION_KEY = "key";
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };
    const result = await new SuuntoProvider().sync(mockDb, new Date("2026-01-01"));
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ============================================================
// syncWebhookEvent tests
// ============================================================

function makeSuuntoInsertMock() {
  return vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "act-uuid" }]),
      }),
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    }),
  });
}

describe("SuuntoProvider.syncWebhookEvent", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns immediately for non-workout objectType", async () => {
    const provider = new SuuntoProvider(async () => new Response());
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "user-123",
      eventType: "create",
      objectType: "profile",
      objectId: "1",
    });

    expect(result.provider).toBe("suunto");
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns error when workout metadata fails validation", async () => {
    const provider = new SuuntoProvider(async () => new Response());
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "user-123",
      eventType: "create",
      objectType: "workout",
      objectId: "w-1",
      metadata: { payload: { bad: "data" } },
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Invalid workout in webhook metadata");
  });

  it("upserts activity on happy path with valid workout metadata", async () => {
    const mockInsert = makeSuuntoInsertMock();
    const mockDb = {
      select: vi.fn(),
      insert: mockInsert,
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const provider = new SuuntoProvider(async () => new Response());
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "user-123",
      eventType: "create",
      objectType: "workout",
      objectId: "w-1",
      metadata: {
        payload: {
          workoutKey: "suunto-w-123",
          activityId: 3,
          workoutName: "Morning Ride",
          startTime: 1709290800000,
          stopTime: 1709294400000,
          totalTime: 3600,
          totalDistance: 30000,
          totalAscent: 300,
          totalDescent: 280,
          avgSpeed: 8.33,
          maxSpeed: 12.0,
          energyConsumption: 700,
          stepCount: 0,
          hrdata: { workoutAvgHR: 145, workoutMaxHR: 175 },
        },
      },
    });

    expect(result.provider).toBe("suunto");
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    // insert called for: ensureProvider + withSyncLog(logSync) + activity upsert
    expect(mockInsert).toHaveBeenCalled();
  });

  it("collects DB insert errors without crashing", async () => {
    const dbError = new Error("DB connection lost");
    let insertCallCount = 0;
    const mockInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation(() => {
        insertCallCount++;
        // First insert call is ensureProvider — let it succeed.
        // Second insert call is the activity inside withSyncLog — make it fail.
        // Third+ calls are logSync — let them succeed.
        if (insertCallCount === 2) {
          return {
            onConflictDoUpdate: vi.fn().mockRejectedValue(dbError),
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          };
        }
        return {
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        };
      }),
    });
    const mockDb = {
      select: vi.fn(),
      insert: mockInsert,
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const provider = new SuuntoProvider(async () => new Response());
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "user-123",
      eventType: "create",
      objectType: "workout",
      objectId: "w-1",
      metadata: {
        payload: {
          workoutKey: "w-fail",
          activityId: 2,
          startTime: 1709290800000,
          stopTime: 1709292600000,
          totalTime: 1800,
          totalDistance: 5000,
          totalAscent: 50,
          totalDescent: 50,
          avgSpeed: 2.78,
          maxSpeed: 3.5,
          energyConsumption: 300,
          stepCount: 3000,
        },
      },
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("DB connection lost");
    expect(result.recordsSynced).toBe(0);
  });
});

// ============================================================
// Additional precise assertions for mutation killing
// ============================================================

describe("SuuntoProvider — precise webhook assertions", () => {
  it("parseWebhookPayload exact structure with all fields present", () => {
    const provider = new SuuntoProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      type: "WORKOUT_CREATED",
      username: "athlete-123",
      workout_id: "w-456",
    });

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.ownerExternalId).toBe("athlete-123");
    expect(event?.eventType).toBe("create");
    expect(event?.objectType).toBe("WORKOUT_CREATED");
    expect(event?.objectId).toBe("w-456");
    expect(event?.metadata).toBeDefined();
    expect(event?.metadata?.payload).toEqual({
      type: "WORKOUT_CREATED",
      username: "athlete-123",
      workout_id: "w-456",
    });
  });

  it("parseWebhookPayload defaults objectType to 'workout' when type is missing", () => {
    const provider = new SuuntoProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      username: "user-1",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.objectType).toBe("workout");
    expect(events[0]?.objectId).toBeUndefined();
  });

  it("parseWebhookPayload returns empty for missing username", () => {
    const provider = new SuuntoProvider(async () => new Response());

    // username is required in the Zod schema
    expect(provider.parseWebhookPayload({ type: "WORKOUT" })).toHaveLength(0);
  });

  it("parseWebhookPayload coerces numeric workout_id to string", () => {
    const provider = new SuuntoProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      username: "user",
      workout_id: 12345,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.objectId).toBe("12345");
  });

  it("verifyWebhookSignature with correct HMAC-SHA256 returns true", () => {
    const { createHmac } = require("node:crypto");
    const provider = new SuuntoProvider(async () => new Response());

    const body = Buffer.from('{"type":"WORKOUT_CREATED","username":"test"}');
    const secret = "my-signing-secret";
    const hmac = createHmac("sha256", secret);
    hmac.update(body);
    const validSig = hmac.digest("hex");

    expect(
      provider.verifyWebhookSignature(body, { "x-hmac-sha256-signature": validSig }, secret),
    ).toBe(true);
  });

  it("verifyWebhookSignature with wrong secret returns false", () => {
    const { createHmac } = require("node:crypto");
    const provider = new SuuntoProvider(async () => new Response());

    const body = Buffer.from("test");
    const hmac = createHmac("sha256", "correct-secret");
    hmac.update(body);
    const sig = hmac.digest("hex");

    expect(
      provider.verifyWebhookSignature(body, { "x-hmac-sha256-signature": sig }, "wrong-secret"),
    ).toBe(false);
  });

  it("registerWebhook returns exact 'suunto-portal-subscription'", async () => {
    const provider = new SuuntoProvider(async () => new Response());
    const result = await provider.registerWebhook("https://example.com/cb", "tok");
    expect(result.subscriptionId).toBe("suunto-portal-subscription");
    expect(result.signingSecret).toBeUndefined();
    expect(result.expiresAt).toBeUndefined();
  });

  it("syncWebhookEvent returns provider 'suunto' for all paths", async () => {
    const provider = new SuuntoProvider(async () => new Response());
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    // Non-workout path
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "user",
      eventType: "create",
      objectType: "profile",
    });
    expect(result.provider).toBe("suunto");
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("syncWebhookEvent invalid metadata path returns provider 'suunto'", async () => {
    const provider = new SuuntoProvider(async () => new Response());
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "user",
      eventType: "create",
      objectType: "workout",
      metadata: { payload: "bad" },
    });
    expect(result.provider).toBe("suunto");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Invalid workout in webhook metadata");
  });

  it("syncWebhookEvent returns error externalId from parsed workout", async () => {
    const dbError = new Error("Test error");
    let insertCallCount = 0;
    const mockInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation(() => {
        insertCallCount++;
        if (insertCallCount === 2) {
          return {
            onConflictDoUpdate: vi.fn().mockRejectedValue(dbError),
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          };
        }
        return {
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        };
      }),
    });
    const mockDb = {
      select: vi.fn(),
      insert: mockInsert,
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const provider = new SuuntoProvider(async () => new Response());
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "user",
      eventType: "create",
      objectType: "workout",
      metadata: {
        payload: {
          workoutKey: "my-workout-key",
          activityId: 2,
          startTime: 1709290800000,
          stopTime: 1709292600000,
          totalTime: 1800,
          totalDistance: 5000,
          totalAscent: 50,
          totalDescent: 50,
          avgSpeed: 2.78,
          maxSpeed: 3.5,
          energyConsumption: 300,
          stepCount: 3000,
        },
      },
    });

    expect(result.provider).toBe("suunto");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.externalId).toBe("my-workout-key");
  });
});

describe("SuuntoProvider — validate exact error messages", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns exact error for SUUNTO_CLIENT_ID", () => {
    delete process.env.SUUNTO_CLIENT_ID;
    delete process.env.SUUNTO_CLIENT_SECRET;
    delete process.env.SUUNTO_SUBSCRIPTION_KEY;
    expect(new SuuntoProvider().validate()).toBe("SUUNTO_CLIENT_ID is not set");
  });

  it("returns exact error for SUUNTO_CLIENT_SECRET", () => {
    process.env.SUUNTO_CLIENT_ID = "id";
    delete process.env.SUUNTO_CLIENT_SECRET;
    delete process.env.SUUNTO_SUBSCRIPTION_KEY;
    expect(new SuuntoProvider().validate()).toBe("SUUNTO_CLIENT_SECRET is not set");
  });

  it("returns exact error for SUUNTO_SUBSCRIPTION_KEY", () => {
    process.env.SUUNTO_CLIENT_ID = "id";
    process.env.SUUNTO_CLIENT_SECRET = "secret";
    delete process.env.SUUNTO_SUBSCRIPTION_KEY;
    expect(new SuuntoProvider().validate()).toBe("SUUNTO_SUBSCRIPTION_KEY is not set");
  });
});

describe("parseSuuntoWorkout — precise raw object assertions", () => {
  it("raw object contains exact fields from workout", () => {
    const workout = {
      workoutKey: "w-precise",
      activityId: 2,
      workoutName: "Run",
      startTime: 1700000000000,
      stopTime: 1700003600000,
      totalTime: 3600,
      totalDistance: 10000,
      totalAscent: 100,
      totalDescent: 90,
      avgSpeed: 2.78,
      maxSpeed: 3.5,
      energyConsumption: 500,
      stepCount: 5000,
    };

    const parsed = parseSuuntoWorkout(workout);
    expect(parsed.raw).toEqual({
      totalDistance: 10000,
      totalTime: 3600,
      totalAscent: 100,
      totalDescent: 90,
      avgSpeed: 2.78,
      maxSpeed: 3.5,
      calories: 500,
      steps: 5000,
      avgHeartRate: undefined,
      maxHeartRate: undefined,
    });
  });

  it("raw object includes HR data when hrdata is present", () => {
    const workout = {
      workoutKey: "w-hr",
      activityId: 3,
      startTime: 1700000000000,
      stopTime: 1700003600000,
      totalTime: 3600,
      totalDistance: 30000,
      totalAscent: 200,
      totalDescent: 200,
      avgSpeed: 8.33,
      maxSpeed: 12.0,
      energyConsumption: 700,
      stepCount: 0,
      hrdata: { workoutAvgHR: 150, workoutMaxHR: 180 },
    };

    const parsed = parseSuuntoWorkout(workout);
    expect(parsed.raw.avgHeartRate).toBe(150);
    expect(parsed.raw.maxHeartRate).toBe(180);
    expect(parsed.activityType).toBe("cycling");
    expect(parsed.name).toBe("Suunto cycling");
  });

  it("parseSuuntoWorkout name fallback includes activity type", () => {
    const workout = {
      workoutKey: "w-noname",
      activityId: 11,
      startTime: 1700000000000,
      stopTime: 1700001800000,
      totalTime: 1800,
      totalDistance: 3000,
      totalAscent: 10,
      totalDescent: 10,
      avgSpeed: 1.67,
      maxSpeed: 2.0,
      energyConsumption: 150,
      stepCount: 2000,
    };

    const parsed = parseSuuntoWorkout(workout);
    expect(parsed.name).toBe("Suunto walking");
  });
});

// ============================================================
// SUUNTO_API_BASE and DEFAULT_REDIRECT_URI — assert exact string values
// ============================================================

describe("suuntoOAuthConfig — exact URL values", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses cloudapi-oauth.suunto.com for authorizeUrl", () => {
    process.env.SUUNTO_CLIENT_ID = "id";
    process.env.SUUNTO_CLIENT_SECRET = "secret";
    const config = suuntoOAuthConfig();
    expect(config?.authorizeUrl).toBe("https://cloudapi-oauth.suunto.com/oauth/authorize");
  });

  it("uses cloudapi-oauth.suunto.com for tokenUrl", () => {
    process.env.SUUNTO_CLIENT_ID = "id";
    process.env.SUUNTO_CLIENT_SECRET = "secret";
    const config = suuntoOAuthConfig();
    expect(config?.tokenUrl).toBe("https://cloudapi-oauth.suunto.com/oauth/token");
  });

  it("defaults redirectUri to production callback when OAUTH_REDIRECT_URI is not set", () => {
    process.env.SUUNTO_CLIENT_ID = "id";
    process.env.SUUNTO_CLIENT_SECRET = "secret";
    delete process.env.OAUTH_REDIRECT_URI;
    const config = suuntoOAuthConfig();
    expect(config?.redirectUri).toBe("https://dofek.asherlc.com/callback");
  });

  it("uses OAUTH_REDIRECT_URI when set", () => {
    process.env.SUUNTO_CLIENT_ID = "id";
    process.env.SUUNTO_CLIENT_SECRET = "secret";
    process.env.OAUTH_REDIRECT_URI = "https://custom.example.com/cb";
    const config = suuntoOAuthConfig();
    expect(config?.redirectUri).toBe("https://custom.example.com/cb");
  });

  it("includes workout scope", () => {
    process.env.SUUNTO_CLIENT_ID = "id";
    process.env.SUUNTO_CLIENT_SECRET = "secret";
    const config = suuntoOAuthConfig();
    expect(config?.scopes).toEqual(["workout"]);
  });
});

describe("SuuntoProvider.authSetup — apiBaseUrl", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns exact Suunto API base URL", () => {
    process.env.SUUNTO_CLIENT_ID = "id";
    process.env.SUUNTO_CLIENT_SECRET = "secret";
    process.env.SUUNTO_SUBSCRIPTION_KEY = "key";
    const provider = new SuuntoProvider();
    const setup = provider.authSetup();
    expect(setup.apiBaseUrl).toBe("https://cloudapi.suunto.com");
  });

  it("exchangeCode is a function", () => {
    process.env.SUUNTO_CLIENT_ID = "id";
    process.env.SUUNTO_CLIENT_SECRET = "secret";
    const provider = new SuuntoProvider();
    const setup = provider.authSetup();
    expect(setup.exchangeCode).toBeTypeOf("function");
  });

  it("throws when env vars are missing", () => {
    delete process.env.SUUNTO_CLIENT_ID;
    delete process.env.SUUNTO_CLIENT_SECRET;
    const provider = new SuuntoProvider();
    expect(() => provider.authSetup()).toThrow("SUUNTO_CLIENT_ID");
  });
});
