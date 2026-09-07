import { createHmac, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SyncDatabase } from "../../db/index.ts";
import {
  activity as activityTable,
  dailyMetrics as dailyMetricsTable,
  sleepSession as sleepSessionTable,
} from "../../db/schema/activity.ts";
import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import { makeTransactionalTestDatabase } from "../test-helpers.ts";
import type { WebhookEvent } from "../types.ts";
import type {
  FitbitActivity,
  FitbitDailySummary,
  FitbitSleepLog,
  FitbitWeightLog,
} from "./client.ts";
import { FitbitProvider, fitbitOAuthConfig } from "./provider.ts";

vi.mock("../../db/provider-data-deletion.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

const { publishedMetricStreamBatches, replacementScopes } = vi.hoisted<{
  publishedMetricStreamBatches: Record<string, unknown>[][];
  replacementScopes: unknown[];
}>(() => ({
  publishedMetricStreamBatches: [],
  replacementScopes: [],
}));

vi.mock("../../metric-stream/redpanda-producer.ts", () => ({
  getDefaultMetricStreamEventPublisher: async () => ({
    publishRows: async (rows: readonly Record<string, unknown>[]) => {
      publishedMetricStreamBatches.push([...rows]);
      return rows.map((row, index) => ({
        version: 1,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        recordedAt: row.recordedAt instanceof Date ? row.recordedAt.toISOString() : row.recordedAt,
      }));
    },
    replaceRows: async (_scope: unknown, rows: readonly Record<string, unknown>[]) => {
      replacementScopes.push(_scope);
      publishedMetricStreamBatches.push([...rows]);
      return {
        deleted: {
          version: 1,
          eventType: "metric_stream_deleted",
          scope: _scope,
          partitionKey: "test-partition",
        },
        rows: rows.map((row, index) => ({
          version: 1,
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          recordedAt:
            row.recordedAt instanceof Date ? row.recordedAt.toISOString() : row.recordedAt,
        })),
      };
    },
  }),
}));

vi.mock("../../db/token-user-context.ts", () => ({
  getTokenUserId: () => "00000000-0000-0000-0000-000000000001",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

afterEach(() => {
  publishedMetricStreamBatches.length = 0;
  replacementScopes.length = 0;
});

// ============================================================
// Mock external dependencies (for sync/webhook tests)
// ============================================================

vi.mock("../../db/sync-log.ts", () => ({
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

vi.mock("../../db/tokens.ts", () => ({
  ensureProvider: vi.fn(async () => "fitbit"),
  loadTokens: vi.fn(async () => ({
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "activity heartrate sleep weight profile",
  })),
  saveTokens: vi.fn(async () => {}),
}));

// ============================================================
// Mock DB (chainable insert pattern)
// ============================================================

function createMockDb() {
  const chain = {
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    returning: vi.fn().mockResolvedValue([{ id: "10000000-0000-4000-8000-000000000001" }]),
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
    execute: vi.fn().mockResolvedValue([]),
  };

  return makeTransactionalTestDatabase(Object.assign(db, chain));
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

const recordSchema = z.record(z.string(), z.unknown());

const sampleTcx = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase>
  <Activities>
    <Activity Sport="Running">
      <Lap StartTime="2026-03-01T08:30:00Z">
        <Track>
          <Trackpoint>
            <Time>2026-03-01T08:30:00Z</Time>
            <Position>
              <LatitudeDegrees>40.7128</LatitudeDegrees>
              <LongitudeDegrees>-74.006</LongitudeDegrees>
            </Position>
            <AltitudeMeters>10.5</AltitudeMeters>
            <HeartRateBpm><Value>155</Value></HeartRateBpm>
            <Cadence>80</Cadence>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

function findValuesCall(
  db: ReturnType<typeof createMockDb>,
  predicate: (val: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  for (const c of db.values.mock.calls) {
    const parsed = recordSchema.safeParse(c[0]);
    if (parsed.success && predicate(parsed.data)) return parsed.data;
    if (Array.isArray(c[0])) {
      for (const value of c[0]) {
        const arrayItemParsed = recordSchema.safeParse(value);
        if (arrayItemParsed.success && predicate(arrayItemParsed.data)) return arrayItemParsed.data;
      }
    }
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
      return new Response(sampleTcx, {
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

// Always restore real timers between tests so a fake clock set by a test that
// throws before its own `vi.useRealTimers()` can't leak into later cases.
afterEach(() => {
  vi.useRealTimers();
});

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
    expect(config?.usePkce).toBe(true);
    expect(config?.scopes).toContain("activity");
    expect(config?.scopes).toContain("sleep");
    expect(config?.scopes).toContain("weight");
    expect(config?.scopes).toContain("heartrate");
    expect(config?.authorizeUrl).toContain("fitbit.com");
    expect(config?.tokenUrl).toContain("fitbit.com");
    expect(config?.revokeUrl).toBe("https://api.fitbit.com/oauth2/revoke");
    expect(config?.tokenAuthMethod).toBe("basic");
  });
});

describe("FitbitProvider — validate", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("has correct id and name", () => {
    const provider = new FitbitProvider();
    expect(provider.id).toBe("fitbit");
    expect(provider.name).toBe("Fitbit");
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

  it("returns null when both env vars are set", () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    process.env.FITBIT_CLIENT_SECRET = "test-secret";
    const provider = new FitbitProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("FitbitProvider — authSetup", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    process.env.FITBIT_CLIENT_SECRET = "test-secret";
    const provider = new FitbitProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig?.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.authUrl).toBeDefined();
    expect(setup.apiBaseUrl).toContain("fitbit.com");
    expect(setup.getUserIdentity).toBeTypeOf("function");
  });

  it("throws when env vars are missing", () => {
    delete process.env.FITBIT_CLIENT_ID;
    delete process.env.FITBIT_CLIENT_SECRET;
    const provider = new FitbitProvider();
    expect(() => provider.authSetup()).toThrow("FITBIT_CLIENT_ID");
  });

  it("includes the PKCE code challenge in the authorization URL", () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    process.env.FITBIT_CLIENT_SECRET = "test-secret";
    const provider = new FitbitProvider();
    const setup = provider.authSetup();
    if (!setup.authUrl) throw new Error("authUrl not defined");

    // The real PKCE challenge must be forwarded. If buildAuthorizationUrl
    // received an empty object ({}), code_challenge would be the literal string
    // "undefined" rather than a real base64url SHA-256 digest.
    const url = new URL(setup.authUrl);
    const codeChallenge = url.searchParams.get("code_challenge");
    expect(codeChallenge).not.toBeNull();
    expect(codeChallenge).not.toBe("undefined");
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe("test-id");
  });

  it("exchangeCode forwards the authorization code to the token endpoint", async () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    process.env.FITBIT_CLIENT_SECRET = "test-secret";

    let capturedBody = "";
    const fetchToken: typeof fetch = async (_input, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return Response.json({
        access_token: "exchanged-access-token",
        refresh_token: "exchanged-refresh-token",
        expires_in: 28800,
        token_type: "Bearer",
        scope: "activity",
      });
    };

    const provider = new FitbitProvider(fetchToken);
    const setup = provider.authSetup();

    // The arrow function must actually call exchangeCodeForTokens with the code
    // and the real PKCE verifier. A missing verifier object ({}) would send
    // code_verifier=undefined; a no-op arrow (() => undefined) would never fetch.
    const { exchangeCode } = setup;
    if (!exchangeCode) throw new Error("exchangeCode not defined");
    const tokens = await exchangeCode("auth-code-123");
    expect(tokens.accessToken).toBe("exchanged-access-token");
    expect(capturedBody).toContain("code=auth-code-123");
    const verifierMatch = capturedBody.match(/(?:^|&)code_verifier=([^&]+)/);
    expect(verifierMatch?.[1]).toBeDefined();
    expect(verifierMatch?.[1]).not.toBe("undefined");
    expect(verifierMatch?.[1]).toMatch(/^[A-Za-z0-9_%-]{20,}$/);
  });

  it("returns a Fitbit profile identity when the profile omits a display name", async () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    process.env.FITBIT_CLIENT_SECRET = "test-secret";
    const fetchProfile: typeof fetch = async (input, init) => {
      expect(input.toString()).toBe("https://api.fitbit.com/1/user/-/profile.json");
      expect(init?.headers).toEqual({ Authorization: "Bearer profile-token" });
      return Response.json({ user: { encodedId: "fitbit-user-id" } });
    };
    const setup = new FitbitProvider(fetchProfile).authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");

    await expect(setup.getUserIdentity("profile-token")).resolves.toEqual({
      providerAccountId: "fitbit-user-id",
      email: null,
      emailVerified: false,
      name: null,
    });
  });

  it("includes Fitbit's response body when profile identity lookup fails", async () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    process.env.FITBIT_CLIENT_SECRET = "test-secret";
    const setup = new FitbitProvider(
      async () => new Response("access denied", { status: 403 }),
    ).authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");

    await expect(setup.getUserIdentity("profile-token")).rejects.toThrow(
      "Fitbit profile API error (403): access denied",
    );
  });
});

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
      const signingSecret = randomBytes(32).toString("hex");
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

    it("returns null for an empty verify param even when verifyToken is empty", () => {
      const provider = new FitbitProvider();
      // `!verify` is true here, so the missing-verify guard must short-circuit.
      // Without that guard the empty verify would equal an empty verifyToken and
      // the challenge string would be returned instead of null.
      const result = provider.handleValidationChallenge({ verify: "" }, "");
      expect(result).toBeNull();
    });
  });

  describe("sync()", () => {
    it("retains non-Error transport failures from each independent sync step", async () => {
      setupEnv();
      const provider = new FitbitProvider(async () => {
        throw "upstream transport unavailable";
      });

      const result = await provider.sync(
        new SyncRun({
          db: createMockDb(),
          window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
        }),
      );

      expect(result.recordsSynced).toBe(0);
      expect(result.errors.map((error) => error.message)).toEqual([
        "activity: upstream transport unavailable",
        "sleep: upstream transport unavailable",
        "daily_metrics 2026-03-01: upstream transport unavailable",
        "weight 2026-03-01: upstream transport unavailable",
      ]);
      expectReasonableDuration(result.duration);
    });

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
      const result = await provider.sync(
        new SyncRun({ db: db, window: SyncWindow.fromSince({ since: since }) }),
      );

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
        "canonicalType",
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
      expect(publishedMetricStreamBatches.flat()).toContainEqual(
        expect.objectContaining({
          providerId: "fitbit",
          externalId: "55555",
          channel: "body_weight",
        }),
      );
      expect(replacementScopes).toContainEqual({
        activityId: "10000000-0000-4000-8000-000000000001",
        userId: "00000000-0000-0000-0000-000000000001",
      });
      expect(replacementScopes).toContainEqual({
        providerId: "fitbit",
        externalId: "55555",
        userId: "00000000-0000-0000-0000-000000000001",
      });
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
      const result = await provider.sync(
        new SyncRun({ db: db, window: SyncWindow.fromSince({ since: since }) }),
      );

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

      const result = await provider.sync(
        new SyncRun({
          db: db,
          window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
        }),
      );
      vi.useRealTimers();

      expect(result.errors).toHaveLength(0);
      expect(result.recordsSynced).toBeGreaterThanOrEqual(2);

      const dailyRow = findValuesCall(
        db,
        (value) => value.providerId === "fitbit" && value.date === "2026-03-01",
      );
      expect(dailyRow.steps).toBe(12345);

      const weightRow = publishedMetricStreamBatches
        .flat()
        .find(
          (value) =>
            value.providerId === "fitbit" &&
            value.externalId === "55555" &&
            value.channel === "body_weight",
        );
      expect(weightRow).toMatchObject({ scalar: 82.5 });
    });

    it("bounds daily summary and weight sync loops by the sync window end", async () => {
      setupEnv();
      vi.useFakeTimers({ now: new Date("2026-04-01T12:00:00Z") });

      try {
        const dailyDates: string[] = [];
        const weightDates: string[] = [];
        const mockFetch: typeof globalThis.fetch = async (
          input: RequestInfo | URL,
        ): Promise<Response> => {
          const url = input.toString();
          if (url.includes("/activities/list.json")) {
            return Response.json({
              activities: [],
              pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
            });
          }
          if (url.includes("/sleep/list.json")) {
            return Response.json({
              sleep: [],
              pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
            });
          }
          if (url.includes("/activities/date/")) {
            const match = url.match(/\/activities\/date\/([\d-]+)\.json/);
            if (match?.[1]) dailyDates.push(match[1]);
            return Response.json(sampleDailySummary);
          }
          if (url.includes("/body/log/weight/date/")) {
            const match = url.match(/\/body\/log\/weight\/date\/([\d-]+)\//);
            if (match?.[1]) weightDates.push(match[1]);
            return Response.json({ weight: [] });
          }
          return new Response("Not found", { status: 404 });
        };

        const result = await new FitbitProvider(mockFetch).sync(
          new SyncRun({
            db: createMockDb(),
            window: SyncWindow.fromDateRange({
              sinceDate: "2026-03-01",
              untilDate: "2026-03-02",
            }),
          }),
        );

        expect(result.errors).toHaveLength(0);
        expect(dailyDates).toEqual(["2026-03-01", "2026-03-02"]);
        expect(weightDates).toEqual(["2026-03-01"]);
        expect(dailyDates).not.toContain("2026-04-01");
        expect(weightDates).not.toContain("2026-04-01");
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns a reasonable duration when token resolution fails", async () => {
      setupEnv();
      const { loadTokens } = await import("../../db/tokens.ts");
      vi.mocked(loadTokens).mockResolvedValueOnce(null);

      const provider = new FitbitProvider(createMockApiFetch());
      const db = createMockDb();

      const since = new Date();
      since.setUTCHours(0, 0, 0, 0);
      const result = await provider.sync(
        new SyncRun({ db: db, window: SyncWindow.fromSince({ since: since }) }),
      );

      expect(result.recordsSynced).toBe(0);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      // duration must be Date.now() - start (a small elapsed time), not a sum.
      expectReasonableDuration(result.duration);
    });

    it("processes the current day when since equals now in daily and weight loops", async () => {
      setupEnv();
      // since and now are the exact same instant: the loop condition must be
      // `<=` (inclusive) for the day to be processed. A `<` condition would skip
      // it entirely, persisting zero daily/weight rows.
      const instant = new Date("2026-03-01T12:00:00Z");
      vi.useFakeTimers({ now: instant });

      const provider = new FitbitProvider(
        createMockApiFetch({
          activities: [],
          sleep: [],
          dailySummary: sampleDailySummary,
          weight: [sampleWeightLog],
        }),
      );
      const db = createMockDb();

      const result = await provider.sync(
        new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date(instant) }) }),
      );
      vi.useRealTimers();

      expect(result.errors).toHaveLength(0);
      // 1 daily summary + 1 weight measurement for the single (current) day.
      expect(result.recordsSynced).toBeGreaterThanOrEqual(2);

      const dailyRow = findValuesCall(
        db,
        (value) => value.providerId === "fitbit" && value.date === "2026-03-01",
      );
      expect(dailyRow.steps).toBe(12345);

      const weightRow = publishedMetricStreamBatches
        .flat()
        .find(
          (value) =>
            value.providerId === "fitbit" &&
            value.externalId === "55555" &&
            value.channel === "body_weight",
        );
      expect(weightRow).toMatchObject({ scalar: 82.5 });
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
      const result = await provider.sync(
        new SyncRun({
          db: db,
          window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
        }),
      );
      vi.useRealTimers();

      expect(result.errors).toHaveLength(0);
      expect(seenOffsets).toEqual([0, 1]);
      expect(findValuesCall(db, (value) => value.externalId === "12345678").name).toBe("Run");
      expect(findValuesCall(db, (value) => value.externalId === "12345679").name).toBe("Run");
      expectReasonableDuration(result.duration);
    });

    it("retains activities when pagination stalls on a non-advancing offset", async () => {
      setupEnv();
      vi.useFakeTimers({ now: new Date("2026-03-01T12:00:00Z") });
      try {
        let activityRequests = 0;

        const mockFetch: typeof globalThis.fetch = async (
          input: RequestInfo | URL,
        ): Promise<Response> => {
          const url = input.toString();
          if (url.includes("/activities/list.json")) {
            activityRequests += 1;
            if (activityRequests > 1) {
              throw new Error("activity pagination should stop after the first stalled page");
            }
            return Response.json({
              activities: [sampleActivity],
              pagination: { next: "/next", previous: "", limit: 0, offset: 0, sort: "asc" },
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
        const result = await provider.sync(
          new SyncRun({
            db: db,
            window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
          }),
        );

        expect(result.errors).toHaveLength(0);
        expect(activityRequests).toBe(1);
        expect(findValuesCall(db, (value) => value.externalId === "12345678").name).toBe("Run");
        expect(db.delete).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("retains earlier activities when a later pagination request fails", async () => {
      setupEnv();
      vi.useFakeTimers({ now: new Date("2026-03-01T12:00:00Z") });
      try {
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
                activities: [sampleActivity],
                pagination: { next: "/next", previous: "", limit: 1, offset: 0, sort: "asc" },
              });
            }
            throw new Error("later activity page failed");
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
        const result = await provider.sync(
          new SyncRun({
            db: db,
            window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
          }),
        );

        expect(seenOffsets).toEqual([0, 1]);
        expect(result.errors).toContainEqual(
          expect.objectContaining({
            message: "activity: later activity page failed",
          }),
        );
        expect(findValuesCall(db, (value) => value.externalId === "12345678").name).toBe("Run");
      } finally {
        vi.useRealTimers();
      }
    });

    it("paginates sleep sync by increasing offset", async () => {
      setupEnv();
      vi.useFakeTimers({ now: new Date("2026-03-01T12:00:00Z") });
      try {
        const firstSleep: FitbitSleepLog = sampleSleep;
        const secondSleep: FitbitSleepLog = { ...sampleSleep, logId: 87654322 };
        const seenSleepOffsets: number[] = [];

        const mockFetch: typeof globalThis.fetch = async (
          input: RequestInfo | URL,
        ): Promise<Response> => {
          const url = input.toString();
          if (url.includes("/activities/list.json")) {
            return Response.json({
              activities: [],
              pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
            });
          }
          if (url.includes("/sleep/list.json")) {
            const offsetMatch = url.match(/[?&]offset=(\d+)/);
            const offset = offsetMatch?.[1] ? Number(offsetMatch[1]) : 0;
            seenSleepOffsets.push(offset);
            if (offset === 0) {
              return Response.json({
                sleep: [firstSleep],
                pagination: { next: "/next", previous: "", limit: 1, offset: 0, sort: "asc" },
              });
            }
            return Response.json({
              sleep: [secondSleep],
              pagination: { next: "", previous: "", limit: 1, offset: 1, sort: "asc" },
            });
          }
          if (url.includes("/activities/date/")) {
            return Response.json(sampleDailySummary);
          }
          if (url.includes("/body/log/weight/date/")) {
            return Response.json({ weight: [] });
          }
          return new Response("Not found", { status: 404 });
        };

        const provider = new FitbitProvider(mockFetch);
        const db = createMockDb();
        const result = await provider.sync(
          new SyncRun({
            db: db,
            window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
          }),
        );

        expect(result.errors).toHaveLength(0);
        // Both pages fetched: offset advanced from 0 to limit (1). A stopped loop
        // (hasMore = false) would only see [0]; a decremented offset would not be [0, 1].
        expect(seenSleepOffsets).toEqual([0, 1]);
        expect(findValuesCall(db, (value) => value.externalId === "87654321").durationMinutes).toBe(
          465,
        );
        expect(findValuesCall(db, (value) => value.externalId === "87654322").durationMinutes).toBe(
          465,
        );
        expectReasonableDuration(result.duration);
      } finally {
        vi.useRealTimers();
      }
    });

    it("fetches a third sleep page when offset advances beyond the first page", async () => {
      setupEnv();
      vi.useFakeTimers({ now: new Date("2026-03-01T12:00:00Z") });
      try {
        const sleeps: FitbitSleepLog[] = [
          { ...sampleSleep, logId: 87654321 },
          { ...sampleSleep, logId: 87654322 },
          { ...sampleSleep, logId: 87654323 },
        ];
        const seenSleepOffsets: number[] = [];

        const mockFetch: typeof globalThis.fetch = async (
          input: RequestInfo | URL,
        ): Promise<Response> => {
          const url = input.toString();
          if (url.includes("/activities/list.json")) {
            return Response.json({
              activities: [],
              pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
            });
          }
          if (url.includes("/sleep/list.json")) {
            const offsetMatch = url.match(/[?&]offset=(\d+)/);
            const offset = offsetMatch?.[1] ? Number(offsetMatch[1]) : 0;
            seenSleepOffsets.push(offset);
            const pageIndex = offset / 10;
            return Response.json({
              sleep: [sleeps[pageIndex] ?? sleeps[0]],
              pagination: {
                next: pageIndex < 2 ? "/next" : "",
                previous: "",
                limit: 10,
                offset,
                sort: "asc",
              },
            });
          }
          if (url.includes("/activities/date/")) {
            return Response.json(sampleDailySummary);
          }
          if (url.includes("/body/log/weight/date/")) {
            return Response.json({ weight: [] });
          }
          return new Response("Not found", { status: 404 });
        };

        const provider = new FitbitProvider(mockFetch);
        const db = createMockDb();
        const result = await provider.sync(
          new SyncRun({
            db: db,
            window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
          }),
        );

        expect(result.errors).toHaveLength(0);
        expect(seenSleepOffsets).toEqual([0, 10, 20]);
        expect(findValuesCall(db, (value) => value.externalId === "87654321").durationMinutes).toBe(
          465,
        );
        expect(findValuesCall(db, (value) => value.externalId === "87654322").durationMinutes).toBe(
          465,
        );
        expect(findValuesCall(db, (value) => value.externalId === "87654323").durationMinutes).toBe(
          465,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("captures per-record sleep insert errors without aborting the whole sync", async () => {
      setupEnv();
      const mockFetch = createMockApiFetch({
        sleep: [sampleSleep, { ...sampleSleep, logId: 87654322 }],
      });
      const provider = new FitbitProvider(mockFetch);
      const db = createMockDb();
      let sleepInsertCount = 0;
      db.onConflictDoUpdate.mockImplementation(() => {
        sleepInsertCount += 1;
        if (sleepInsertCount === 1) {
          throw new Error("sleep insert failed");
        }
        return db;
      });

      const result = await provider.sync(
        new SyncRun({
          db: db,
          window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
        }),
      );

      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors.some((error) => error.externalId === "87654321")).toBe(true);
      expect(findValuesCall(db, (value) => value.externalId === "87654322").durationMinutes).toBe(
        465,
      );
    });

    it("retains sleep records when pagination stalls on a repeated offset", async () => {
      setupEnv();
      vi.useFakeTimers({ now: new Date("2026-03-01T12:00:00Z") });
      try {
        const stalledSleep: FitbitSleepLog = { ...sampleSleep, logId: 87654321 };
        let sleepRequests = 0;

        const mockFetch: typeof globalThis.fetch = async (
          input: RequestInfo | URL,
        ): Promise<Response> => {
          const url = input.toString();
          if (url.includes("/activities/list.json")) {
            return Response.json({
              activities: [],
              pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
            });
          }
          if (url.includes("/sleep/list.json")) {
            sleepRequests += 1;
            return Response.json({
              sleep: [stalledSleep],
              pagination: { next: "/next", previous: "", limit: 0, offset: 0, sort: "asc" },
            });
          }
          if (url.includes("/activities/date/")) {
            return Response.json(sampleDailySummary);
          }
          if (url.includes("/body/log/weight/date/")) {
            return Response.json({ weight: [] });
          }
          return new Response("Not found", { status: 404 });
        };

        const provider = new FitbitProvider(mockFetch);
        const db = createMockDb();
        const result = await provider.sync(
          new SyncRun({
            db: db,
            window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
          }),
        );

        expect(result.errors).toHaveLength(0);
        expect(sleepRequests).toBe(1);
        expect(findValuesCall(db, (value) => value.externalId === "87654321").durationMinutes).toBe(
          465,
        );
      } finally {
        vi.useRealTimers();
      }
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
      expect(activityValues.canonicalType).toBe("running");
      expect(activityValues.providerType).toBe("90009");
      expect(activityValues.name).toBe("Run");
      expectConflictTarget(db, [
        activityTable.userId,
        activityTable.providerId,
        activityTable.externalId,
      ]);
      expectConflictSetContainsKey(
        db,
        [activityTable.userId, activityTable.providerId, activityTable.externalId],
        "canonicalType",
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

    it("paginates webhook activity sync by increasing offset", async () => {
      setupEnv();
      const firstActivity: FitbitActivity = sampleActivity;
      const secondActivity: FitbitActivity = { ...sampleActivity, logId: 12345679 };
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
        if (url.includes("/activities/date/")) {
          return Response.json(sampleDailySummary);
        }
        if (url.endsWith(".tcx")) {
          return new Response("<TrainingCenterDatabase></TrainingCenterDatabase>", { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      };

      const provider = new FitbitProvider(mockFetch);
      const db = createMockDb();
      const event: WebhookEvent = {
        ownerExternalId: "USER1",
        eventType: "update",
        objectType: "activities",
        metadata: { date: "2026-03-01" },
      };

      const result = await provider.syncWebhookEvent(db, event);

      expect(result.errors).toHaveLength(0);
      expect(seenOffsets).toEqual([0, 1]);
      expect(findValuesCall(db, (value) => value.externalId === "12345678").name).toBe("Run");
      expect(findValuesCall(db, (value) => value.externalId === "12345679").name).toBe("Run");
      expectReasonableDuration(result.duration);
    });

    it("paginates webhook sleep sync by increasing offset", async () => {
      setupEnv();
      const firstSleep: FitbitSleepLog = sampleSleep;
      const secondSleep: FitbitSleepLog = { ...sampleSleep, logId: 87654322 };
      const seenOffsets: number[] = [];

      const mockFetch: typeof globalThis.fetch = async (
        input: RequestInfo | URL,
      ): Promise<Response> => {
        const url = input.toString();
        if (url.includes("/sleep/list.json")) {
          const offsetMatch = url.match(/[?&]offset=(\d+)/);
          const offset = offsetMatch?.[1] ? Number(offsetMatch[1]) : 0;
          seenOffsets.push(offset);
          if (offset === 0) {
            return Response.json({
              sleep: [firstSleep],
              pagination: { next: "/next", previous: "", limit: 1, offset: 0, sort: "asc" },
            });
          }
          return Response.json({
            sleep: [secondSleep],
            pagination: { next: "", previous: "", limit: 1, offset: 1, sort: "asc" },
          });
        }
        return new Response("Not found", { status: 404 });
      };

      const provider = new FitbitProvider(mockFetch);
      const db = createMockDb();
      const event: WebhookEvent = {
        ownerExternalId: "USER1",
        eventType: "update",
        objectType: "sleep",
        metadata: { date: "2026-03-01" },
      };

      const result = await provider.syncWebhookEvent(db, event);

      expect(result.errors).toHaveLength(0);
      expect(seenOffsets).toEqual([0, 1]);
      expect(result.recordsSynced).toBe(2);
      expect(findValuesCall(db, (value) => value.externalId === "87654321").durationMinutes).toBe(
        465,
      );
      expect(findValuesCall(db, (value) => value.externalId === "87654322").durationMinutes).toBe(
        465,
      );
      expectReasonableDuration(result.duration);
    });

    it("queries the event metadata date rather than today", async () => {
      setupEnv();
      vi.useFakeTimers({ now: new Date("2026-06-15T12:00:00Z") });

      const capturedDailyDates: string[] = [];
      const mockFetch: typeof globalThis.fetch = async (
        input: RequestInfo | URL,
      ): Promise<Response> => {
        const url = input.toString();
        if (url.includes("/activities/list.json")) {
          // afterDate carries the event date for the activity list query
          const match = url.match(/afterDate=([\d-]+)/);
          if (match?.[1]) capturedDailyDates.push(match[1]);
          return Response.json({
            activities: [],
            pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
          });
        }
        if (url.includes("/activities/date/")) {
          const match = url.match(/\/activities\/date\/([\d-]+)\.json/);
          if (match?.[1]) capturedDailyDates.push(match[1]);
          return Response.json(sampleDailySummary);
        }
        return new Response("Not found", { status: 404 });
      };

      const provider = new FitbitProvider(mockFetch);
      const db = createMockDb();
      const event: WebhookEvent = {
        ownerExternalId: "USER1",
        eventType: "update",
        objectType: "activities",
        metadata: { date: "2026-03-01" },
      };

      const result = await provider.syncWebhookEvent(db, event);
      vi.useRealTimers();

      expect(result.errors).toHaveLength(0);
      // The event's metadata.date ("2026-03-01") must be used, not today
      // ("2026-06-15"). The mutated ternary would always fall back to today.
      expect(capturedDailyDates.length).toBeGreaterThan(0);
      expect(capturedDailyDates.every((date) => date === "2026-03-01")).toBe(true);
      expect(capturedDailyDates).not.toContain("2026-06-15");
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
      expect(sleepValues.stagingAvailable).toBe(true);
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
      expect(db.delete).not.toHaveBeenCalled();

      const publishedRows = publishedMetricStreamBatches.flat();
      const weightValues = publishedRows.find(
        (value) =>
          value.externalId === "55555" &&
          value.providerId === "fitbit" &&
          value.channel === "body_weight",
      );
      expect(weightValues).toMatchObject({ scalar: 82.5 });
      const bodyFatValues = publishedRows.find(
        (value) =>
          value.externalId === "55555" &&
          value.providerId === "fitbit" &&
          value.channel === "body_fat_percentage",
      );
      expect(bodyFatValues).toMatchObject({ scalar: 18.5 });
      expect(replacementScopes).toContainEqual({
        providerId: "fitbit",
        externalId: "55555",
        userId: "00000000-0000-0000-0000-000000000001",
      });
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
      const { loadTokens } = await import("../../db/tokens.ts");
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
