import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WhoopClient,
  type WhoopHrValue,
  type WhoopRecoveryRecord,
  type WhoopSleepRecord,
  type WhoopWeightliftingWorkoutResponse,
  type WhoopWorkoutRecord,
} from "whoop-whoop";
import type { SyncDatabase } from "../db/index.ts";
import { parseJournalResponse } from "./whoop/journal-parsing.ts";
import {
  parseHeartRateValues,
  parseRecovery,
  parseSleep,
  parseWeightliftingWorkout,
  parseWorkout,
} from "./whoop/parsing.ts";
import { WhoopProvider } from "./whoop/provider.ts";

// ============================================================
// Mocks for sync tests
// ============================================================

vi.mock("../db/sync-log.ts", () => ({
  withSyncLog: vi.fn(
    (
      _db: unknown,
      _provider: string,
      _type: string,
      fn: () => Promise<{ recordCount: number; result: number }>,
    ) => fn().then((r) => r.result),
  ),
}));

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn(),
  loadTokens: vi.fn(),
  saveTokens: vi.fn(),
}));

function makeChainableMock(resolvedValue: unknown = []) {
  const selectFn = vi.fn();
  const insertFn = vi.fn();
  const deleteFn = vi.fn();
  const executeFn = vi.fn().mockResolvedValue([]);

  // Self-referencing chain: each method returns the mock object
  const chain = {
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    onConflictDoNothing: vi.fn().mockResolvedValue(resolvedValue),
    returning: vi.fn().mockResolvedValue(resolvedValue),
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue(resolvedValue),
  };

  // Make each chain method return the chain for fluent chaining
  for (const fn of Object.values(chain)) {
    fn.mockReturnValue(chain);
  }
  selectFn.mockReturnValue(chain);
  insertFn.mockReturnValue(chain);
  deleteFn.mockReturnValue(chain);

  const db: SyncDatabase = {
    select: selectFn,
    insert: insertFn,
    delete: deleteFn,
    execute: executeFn,
  };

  // Return an object that is both SyncDatabase and has chain spies accessible
  return Object.assign(db, chain);
}

// Helper to make a WhoopClient-shaped mock via fetch
function makeSyncMockFetch(options: {
  cycles?: unknown[];
  sleepData?: unknown;
  weightliftingData?: unknown;
  hrValues?: unknown[];
  journalData?: unknown;
  sleepError?: boolean;
  hrError?: boolean;
  journalError?: boolean;
  cyclesError?: boolean;
}) {
  const mockFetch: typeof globalThis.fetch = (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = input.toString();

    // Auth: Cognito refresh
    if (url.includes("auth-service/v3/whoop")) {
      return Promise.resolve(
        Response.json({
          AuthenticationResult: { AccessToken: "new-tok", RefreshToken: "new-ref" },
        }),
      );
    }

    // Bootstrap: user ID
    if (url.includes("users-service/v2/bootstrap")) {
      return Promise.resolve(Response.json({ id: 42 }));
    }

    // Cycles (core-details-bff/v0/cycles/details)
    if (url.includes("cycles/details")) {
      if (options.cyclesError) {
        return Promise.resolve(new Response("Server error", { status: 500 }));
      }
      return Promise.resolve(Response.json(options.cycles ?? []));
    }

    // Sleep by ID (sleep-service/v1/sleep-events?activityId=...)
    if (url.includes("sleep-service")) {
      if (options.sleepError) {
        return Promise.resolve(new Response("Sleep error", { status: 500 }));
      }
      return Promise.resolve(Response.json(options.sleepData ?? {}));
    }

    // Heart rate (metrics-service/v1/metrics/user/...)
    if (url.includes("metrics-service")) {
      if (options.hrError) {
        return Promise.resolve(new Response("HR error", { status: 500 }));
      }
      return Promise.resolve(Response.json({ values: options.hrValues ?? [] }));
    }

    // Weightlifting
    if (url.includes("weightlifting-service")) {
      if (options.weightliftingData === null) {
        return Promise.resolve(new Response("", { status: 404 }));
      }
      return Promise.resolve(Response.json(options.weightliftingData ?? null));
    }

    // Journal
    if (url.includes("behavior-impact-service")) {
      if (options.journalError) {
        return Promise.resolve(new Response("Journal error", { status: 500 }));
      }
      return Promise.resolve(Response.json(options.journalData ?? []));
    }

    return Promise.resolve(new Response("Not found", { status: 404 }));
  };
  return mockFetch;
}

/** Type guard: value is a non-null, non-array object with string keys */
function isRecord(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

/** Type guard: value is a non-empty array of record objects */
function isRecordArray(val: unknown): val is Record<string, unknown>[] {
  return Array.isArray(val) && val.length > 0 && isRecord(val[0]);
}

/**
 * Extract all first-argument values from db.values mock calls.
 * Each call[0] is the value passed to `.values(...)`.
 */
function getValuesCallArgs(db: ReturnType<typeof makeChainableMock>): unknown[] {
  return db.values.mock.calls.map((call: unknown[]) => call[0]);
}

/**
 * Find a record-type values() call matching a predicate.
 * Returns undefined if no matching call is found.
 */
function findValuesRecord(
  args: unknown[],
  predicate: (rec: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  for (const arg of args) {
    if (isRecord(arg) && predicate(arg)) return arg;
  }
  return undefined;
}

/**
 * Find an array-type values() call matching a predicate.
 * Returns undefined if no matching call is found.
 */
function findValuesBatch(
  args: unknown[],
  predicate: (arr: Record<string, unknown>[]) => boolean,
): Record<string, unknown>[] | undefined {
  for (const arg of args) {
    if (isRecordArray(arg) && predicate(arg)) return arg;
  }
  return undefined;
}

/**
 * Extract all first-argument values from db.onConflictDoUpdate mock calls.
 * Each call[0] is the options object passed to `.onConflictDoUpdate(...)`.
 */
function getOnConflictArgs(db: ReturnType<typeof makeChainableMock>): unknown[] {
  return db.onConflictDoUpdate.mock.calls.map((call: unknown[]) => call[0]);
}

/**
 * Find an onConflictDoUpdate call matching a predicate.
 */
function findOnConflictRecord(
  args: unknown[],
  predicate: (rec: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  for (const arg of args) {
    if (isRecord(arg) && predicate(arg)) return arg;
  }
  return undefined;
}

// ============================================================
// Pure parsing unit tests (no DB, no network)
// ============================================================

const sampleRecovery: WhoopRecoveryRecord = {
  cycle_id: 93845,
  sleep_id: 10235,
  user_id: 10129,
  created_at: "2026-03-01T11:25:44.774Z",
  updated_at: "2026-03-01T14:25:44.774Z",
  score_state: "SCORED",
  score: {
    user_calibrating: false,
    recovery_score: 78,
    resting_heart_rate: 52,
    hrv_rmssd_milli: 65.5,
    spo2_percentage: 97.2,
    skin_temp_celsius: 33.7,
  },
};

const sampleSleep: WhoopSleepRecord = {
  id: 10235,
  user_id: 10129,
  created_at: "2026-03-01T06:00:00Z",
  updated_at: "2026-03-01T06:30:00Z",
  start: "2026-02-28T23:00:00Z",
  end: "2026-03-01T06:30:00Z",
  timezone_offset: "-05:00",
  nap: false,
  score_state: "SCORED",
  score: {
    stage_summary: {
      total_in_bed_time_milli: 27000000,
      total_awake_time_milli: 1800000,
      total_no_data_time_milli: 0,
      total_light_sleep_time_milli: 10800000,
      total_slow_wave_sleep_time_milli: 7200000,
      total_rem_sleep_time_milli: 5400000,
      sleep_cycle_count: 4,
      disturbance_count: 2,
    },
    sleep_needed: {
      baseline_milli: 28800000,
      need_from_sleep_debt_milli: 1800000,
      need_from_recent_strain_milli: 900000,
      need_from_recent_nap_milli: 0,
    },
    respiratory_rate: 16.1,
    sleep_performance_percentage: 92,
    sleep_consistency_percentage: 88,
    sleep_efficiency_percentage: 91.7,
  },
};

const sampleWorkout: WhoopWorkoutRecord = {
  activity_id: "abc12345-6789-0def-1234-567890abcdef",
  during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
  timezone_offset: "-05:00",
  sport_id: 0,
  average_heart_rate: 155,
  max_heart_rate: 185,
  kilojoules: 2500.5,
  percent_recorded: 100,
  score: 12.5,
};

/** Helper: mock fetch that routes Cognito calls and user bootstrap */
function makeCognitoMockFetch(
  cognitoHandler: (body: Record<string, unknown>, headers: Record<string, string>) => unknown,
) {
  const mockFetch: typeof globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("auth-service/v3/whoop")) {
      const body = JSON.parse(String(init?.body ?? ""));
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers)) {
          headers[k] = v;
        }
      }
      const result = cognitoHandler(body, headers);
      return Promise.resolve(Response.json(result));
    }
    if (url.includes("users-service/v2/bootstrap")) {
      return Promise.resolve(Response.json({ id: 42 }));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };
  return mockFetch;
}

describe("WhoopClient.signIn (Cognito v3)", () => {
  it("calls Cognito InitiateAuth with USER_PASSWORD_AUTH", async () => {
    let capturedBody: Record<string, unknown> = {};
    let capturedTarget = "";
    const mockFetch = makeCognitoMockFetch((body, headers) => {
      capturedBody = body;
      capturedTarget = headers["X-Amz-Target"] ?? "";
      return {
        AuthenticationResult: {
          AccessToken: "tok",
          RefreshToken: "ref",
        },
      };
    });

    await WhoopClient.signIn("user@test.com", "pass", mockFetch);
    expect(capturedTarget).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    expect(capturedBody.AuthFlow).toBe("USER_PASSWORD_AUTH");
    const authParams = capturedBody.AuthParameters;
    expect(authParams).toBeDefined();
    if (
      authParams &&
      typeof authParams === "object" &&
      "USERNAME" in authParams &&
      "PASSWORD" in authParams
    ) {
      expect(authParams.USERNAME).toBe("user@test.com");
      expect(authParams.PASSWORD).toBe("pass");
    }
  });

  it("fetches user ID from users-service bootstrap after sign-in", async () => {
    const mockFetch = makeCognitoMockFetch(() => ({
      AuthenticationResult: { AccessToken: "tok", RefreshToken: "ref" },
    }));

    const result = await WhoopClient.signIn("user@test.com", "pass", mockFetch);
    expect(result.type).toBe("success");
    if (result.type === "success") {
      expect(result.token.userId).toBe(42);
    }
  });

  it("returns verification_required when MFA challenge is returned", async () => {
    const mockFetch = makeCognitoMockFetch(() => ({
      ChallengeName: "SMS_MFA",
      Session: "session-abc",
    }));

    const result = await WhoopClient.signIn("user@test.com", "pass", mockFetch);
    expect(result.type).toBe("verification_required");
    if (result.type === "verification_required") {
      expect(result.session).toBe("session-abc");
      expect(result.method).toBe("sms");
    }
  });

  it("authenticate() throws on MFA-required accounts", async () => {
    const mockFetch = makeCognitoMockFetch(() => ({
      ChallengeName: "SMS_MFA",
      Session: "session-abc",
    }));

    await expect(WhoopClient.authenticate("user@test.com", "pass", mockFetch)).rejects.toThrow(
      "MFA",
    );
  });
});

describe("WhoopClient.refreshAccessToken (Cognito v3)", () => {
  it("calls Cognito InitiateAuth with REFRESH_TOKEN_AUTH", async () => {
    let capturedBody: Record<string, unknown> = {};
    const mockFetch = makeCognitoMockFetch((body) => {
      capturedBody = body;
      return {
        AuthenticationResult: { AccessToken: "new-tok" },
      };
    });

    const token = await WhoopClient.refreshAccessToken("old-ref", mockFetch);
    expect(capturedBody.AuthFlow).toBe("REFRESH_TOKEN_AUTH");
    const refreshParams = capturedBody.AuthParameters;
    expect(refreshParams).toBeDefined();
    if (refreshParams && typeof refreshParams === "object" && "REFRESH_TOKEN" in refreshParams) {
      expect(refreshParams.REFRESH_TOKEN).toBe("old-ref");
    }
    expect(token.accessToken).toBe("new-tok");
    expect(token.refreshToken).toBe("old-ref"); // reuses old when not returned
    expect(token.userId).toBe(42);
  });
});

describe("WhoopClient._fetchUserId edge cases", () => {
  it("throws when bootstrap response contains no user ID", async () => {
    const mockFetch: typeof globalThis.fetch = (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            AuthenticationResult: { AccessToken: "tok", RefreshToken: "ref" },
          }),
        );
      }
      if (url.includes("users-service/v2/bootstrap")) {
        // Response with no id field at all
        return Promise.resolve(Response.json({ profile: { name: "Test" } }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    await expect(WhoopClient.signIn("user@test.com", "pass", mockFetch)).rejects.toThrow(
      /user ID/i,
    );
  });

  it("extracts user ID from nested user object", async () => {
    const mockFetch: typeof globalThis.fetch = (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            AuthenticationResult: { AccessToken: "tok", RefreshToken: "ref" },
          }),
        );
      }
      if (url.includes("users-service/v2/bootstrap")) {
        // Some WHOOP API versions nest it under `user`
        return Promise.resolve(Response.json({ user: { id: 99 } }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const result = await WhoopClient.signIn("user@test.com", "pass", mockFetch);
    expect(result.type).toBe("success");
    if (result.type === "success") {
      expect(result.token.userId).toBe(99);
    }
  });
});

describe("WhoopClient.refreshAccessToken — bootstrap failure", () => {
  it("returns null userId when bootstrap endpoint fails", async () => {
    const mockFetch: typeof globalThis.fetch = (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            AuthenticationResult: { AccessToken: "new-tok" },
          }),
        );
      }
      if (url.includes("users-service/v2/bootstrap")) {
        // Bootstrap returns no user ID
        return Promise.resolve(Response.json({ profile: {} }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const token = await WhoopClient.refreshAccessToken("old-ref", mockFetch);
    expect(token.accessToken).toBe("new-tok");
    expect(token.userId).toBeNull();
  });
});

describe("WHOOP Provider — parsing", () => {
  describe("parseRecovery", () => {
    it("maps recovery fields to daily metrics", () => {
      const result = parseRecovery(sampleRecovery);
      expect(result.restingHr).toBe(52);
      expect(result.hrv).toBeCloseTo(65.5);
    });

    it("returns null fields for unscored recovery", () => {
      const unscored = { ...sampleRecovery, score_state: "PENDING_SCORE", score: undefined };
      const unscoredRecord: WhoopRecoveryRecord = unscored;
      const result = parseRecovery(unscoredRecord);
      expect(result.restingHr).toBeUndefined();
      expect(result.hrv).toBeUndefined();
    });

    it("parses BFF v0 flat recovery format (state: complete, fields at top level)", () => {
      // This is the actual shape returned by the WHOOP BFF API in production.
      // Fields are flat (not nested under `score`) and use different key names.
      const bffRecovery: WhoopRecoveryRecord = {
        cycle_id: 93845,
        sleep_id: 10235,
        user_id: 10129,
        created_at: "2026-03-19T11:25:44.774Z",
        updated_at: "2026-03-19T14:25:44.774Z",
        score_state: "complete",
        recovery_score: 88,
        resting_heart_rate: 57,
        hrv_rmssd: 0.077110276,
        spo2_percentage: 96.5,
        skin_temp_celsius: 34.2,
        calibrating: false,
      };
      const result = parseRecovery(bffRecovery);
      expect(result.restingHr).toBe(57);
      expect(result.hrv).toBeCloseTo(77.1, 0);
      expect(result.spo2).toBeCloseTo(96.5);
      expect(result.skinTemp).toBeCloseTo(34.2);
    });

    it("parses BFF v0 recovery with missing optional fields", () => {
      const bffRecovery: WhoopRecoveryRecord = {
        cycle_id: 93846,
        sleep_id: 10236,
        user_id: 10129,
        created_at: "2026-03-20T11:25:44.774Z",
        updated_at: "2026-03-20T14:25:44.774Z",
        score_state: "complete",
        recovery_score: 72,
        resting_heart_rate: 60,
        hrv_rmssd: 0.055,
        calibrating: false,
      };
      const result = parseRecovery(bffRecovery);
      expect(result.restingHr).toBe(60);
      expect(result.hrv).toBeCloseTo(55, 0);
      expect(result.spo2).toBeUndefined();
      expect(result.skinTemp).toBeUndefined();
    });

    it("parses BFF v0 recovery with unknown state value (API drift)", () => {
      // The WHOOP API has returned various state values over time. The parser
      // should accept recovery data whenever biometric fields are present,
      // regardless of what `state` says.
      const bffRecovery: WhoopRecoveryRecord = {
        user_id: 10129,
        created_at: "2026-03-26T11:25:44.774Z",
        updated_at: "2026-03-26T14:25:44.774Z",
        state: "responded",
        recovery_score: 65,
        resting_heart_rate: 63,
        hrv_rmssd: 0.048,
        spo2: 97,
        skin_temp_celsius: 34.857334,
        calibrating: false,
      };
      const result = parseRecovery(bffRecovery);
      expect(result.restingHr).toBe(63);
      expect(result.hrv).toBeCloseTo(48, 0);
      expect(result.spo2).toBe(97);
      expect(result.skinTemp).toBeCloseTo(34.86, 1);
    });
  });

  describe("parseSleep", () => {
    it("maps sleep fields to sleep session", () => {
      const result = parseSleep(sampleSleep);
      expect(result).not.toBeNull();
      expect(result?.externalId).toBe("10235");
      expect(result?.startedAt).toEqual(new Date("2026-02-28T23:00:00Z"));
      expect(result?.endedAt).toEqual(new Date("2026-03-01T06:30:00Z"));
      expect(result?.deepMinutes).toBe(120); // 7200000ms / 60000
      expect(result?.remMinutes).toBe(90);
      expect(result?.lightMinutes).toBe(180);
      expect(result?.awakeMinutes).toBe(30);
      expect(result?.efficiencyPct).toBeCloseTo(91.7);
      expect(result?.isNap).toBe(false);
    });

    it("defaults all stage times to 0 when score is missing", () => {
      const noScore: WhoopSleepRecord = {
        ...sampleSleep,
        score: undefined,
      };
      const result = parseSleep(noScore);
      expect(result).not.toBeNull();
      expect(result?.durationMinutes).toBe(0);
      expect(result?.deepMinutes).toBe(0);
      expect(result?.remMinutes).toBe(0);
      expect(result?.lightMinutes).toBe(0);
      expect(result?.awakeMinutes).toBe(0);
      expect(result?.efficiencyPct).toBeUndefined();
    });

    it("marks naps as isNap=true", () => {
      const nap: WhoopSleepRecord = { ...sampleSleep, nap: true };
      expect(parseSleep(nap)?.isNap).toBe(true);
    });
  });

  describe("parseWorkout", () => {
    it("maps workout fields to cardio activity", () => {
      const result = parseWorkout(sampleWorkout);
      expect(result.externalId).toBe("abc12345-6789-0def-1234-567890abcdef");
      expect(result.activityType).toBe("running");
      expect(result.avgHeartRate).toBe(155);
      expect(result.maxHeartRate).toBe(185);
      expect(result.calories).toBe(598); // 2500.5 kJ / 4.184
      expect(result.startedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
      expect(result.endedAt).toEqual(new Date("2026-03-01T11:00:00Z"));
      expect(result.durationSeconds).toBe(3600);
    });
  });

  describe("parseHeartRateValues", () => {
    it("converts WHOOP HR values to parsed records", () => {
      const values: WhoopHrValue[] = [
        { time: 1709251200000, data: 72 },
        { time: 1709251206000, data: 75 },
        { time: 1709251212000, data: 78 },
      ];
      const records = parseHeartRateValues(values);
      expect(records).toHaveLength(3);
      expect(records[0]?.heartRate).toBe(72);
      expect(records[0]?.recordedAt).toEqual(new Date(1709251200000));
      expect(records[2]?.heartRate).toBe(78);
    });
  });
});

// ============================================================
// Sync flow tests (mocked DB + client)
// ============================================================

// Default future expiry for token mocks
const futureExpiry = new Date("2099-01-01T00:00:00Z");

describe("WhoopProvider.sync() — token resolution", () => {
  it("returns error when no tokens are stored", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce(null);

    const provider = new WhoopProvider();
    const db = makeChainableMock();
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("not connected");
  });

  it("returns error when refreshToken is missing", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "tok",
      refreshToken: "",
      expiresAt: futureExpiry,
      scopes: null,
    });

    const provider = new WhoopProvider();
    const db = makeChainableMock();
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("not connected");
  });

  it("returns error when user ID not found after refresh", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: futureExpiry,
      scopes: null,
    });

    // Mock fetch that returns no user ID from bootstrap
    const mockFetch: typeof globalThis.fetch = (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            AuthenticationResult: { AccessToken: "new-tok" },
          }),
        );
      }
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ something: "else" }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("user ID not found");
  });

  it("uses stored userId from scopes when available", async () => {
    const { loadTokens, saveTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: futureExpiry,
      scopes: "userId:12345",
    });

    const mockFetch = makeSyncMockFetch({ cycles: [] });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");
    // saveTokens should have been called with userId:12345 in scopes
    expect(saveTokens).toHaveBeenCalled();
    const savedScopes = vi.mocked(saveTokens).mock.calls[0]?.[2]?.scopes;
    expect(savedScopes).toBe("userId:12345");
  });
});

describe("WhoopProvider.sync() — cycles error", () => {
  it("returns error when getCycles fails", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: futureExpiry,
      scopes: "userId:42",
    });

    const mockFetch = makeSyncMockFetch({ cyclesError: true });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("getCycles");
  });
});

describe("WhoopProvider.sync() — recovery sync", () => {
  it("syncs recovery data from scored cycles", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: futureExpiry,
      scopes: "userId:42",
    });

    const cycles = [
      {
        days: ["2026-03-01"],
        recovery: {
          cycle_id: 1,
          sleep_id: 1,
          user_id: 42,
          created_at: "2026-03-01T06:00:00Z",
          updated_at: "2026-03-01T06:00:00Z",
          score_state: "SCORED",
          score: {
            user_calibrating: false,
            recovery_score: 80,
            resting_heart_rate: 50,
            hrv_rmssd_milli: 70,
            spo2_percentage: 98,
            skin_temp_celsius: 33.5,
          },
        },
        sleep: null,
        workouts: [],
      },
    ];

    const mockFetch = makeSyncMockFetch({
      cycles,
      journalData: [],
      hrValues: [],
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    // Make onConflictDoUpdate resolve properly for recovery insert chain
    db.onConflictDoUpdate = vi.fn().mockResolvedValue([]);
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");
    // The sync completes (recovery/sleep/workouts/hr/journal phases all run)
    expect(result.recordsSynced).toBeGreaterThanOrEqual(0);
  });

  it("uses created_at date fallback when days array is empty", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: futureExpiry,
      scopes: "userId:42",
    });

    const cycles = [
      {
        days: [],
        recovery: {
          cycle_id: 2,
          sleep_id: 2,
          user_id: 42,
          created_at: "2026-03-02T06:00:00Z",
          updated_at: "2026-03-02T06:00:00Z",
          score_state: "SCORED",
          score: {
            user_calibrating: false,
            recovery_score: 75,
            resting_heart_rate: 55,
            hrv_rmssd_milli: 60,
          },
        },
        sleep: null,
        workouts: [],
      },
    ];

    const mockFetch = makeSyncMockFetch({
      cycles,
      journalData: [],
      hrValues: [],
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    db.onConflictDoUpdate = vi.fn().mockResolvedValue([]);
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");
  });

  it("skips unscored recovery cycles", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: futureExpiry,
      scopes: "userId:42",
    });

    const cycles = [
      {
        days: ["2026-03-01"],
        recovery: {
          cycle_id: 3,
          sleep_id: 3,
          user_id: 42,
          created_at: "2026-03-01T06:00:00Z",
          updated_at: "2026-03-01T06:00:00Z",
          score_state: "PENDING",
        },
        sleep: null,
        workouts: [],
      },
    ];

    const mockFetch = makeSyncMockFetch({
      cycles,
      journalData: [],
      hrValues: [],
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");
  });

  it("logs info (not warn) for unscored recovery with undefined state", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: futureExpiry,
      scopes: "userId:42",
    });

    const { logger } = await import("../logger.ts");
    const warnSpy = vi.spyOn(logger, "warn");
    const infoSpy = vi.spyOn(logger, "info");

    const cycles = [
      {
        days: ["2026-03-01"],
        recovery: {
          cycle_id: 3,
          user_id: 42,
          created_at: "2026-03-01T06:00:00Z",
          updated_at: "2026-03-01T06:00:00Z",
          // No score_state, no state, no biometric data — unscored cycle
        },
        sleep: null,
        workouts: [],
      },
    ];

    const mockFetch = makeSyncMockFetch({
      cycles,
      journalData: [],
      hrValues: [],
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    await provider.sync(db, new Date("2026-03-01"));

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping unscored recovery"));
    // Should NOT produce a warning for expected unscored cycles
    const recoveryWarns = warnSpy.mock.calls.filter((call) => {
      const msg = String(call[0]);
      return msg.includes("[whoop]") && msg.includes("recovery");
    });
    expect(recoveryWarns).toHaveLength(0);

    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("warns when SCORED recovery has no parseable biometric data", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: futureExpiry,
      scopes: "userId:42",
    });

    const { logger } = await import("../logger.ts");
    const warnSpy = vi.spyOn(logger, "warn");

    const cycles = [
      {
        days: ["2026-03-01"],
        recovery: {
          cycle_id: 3,
          user_id: 42,
          created_at: "2026-03-01T06:00:00Z",
          updated_at: "2026-03-01T06:00:00Z",
          score_state: "SCORED",
          // SCORED but no `score` object and no flat biometric fields — API change
        },
        sleep: null,
        workouts: [],
      },
    ];

    const mockFetch = makeSyncMockFetch({
      cycles,
      journalData: [],
      hrValues: [],
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    await provider.sync(db, new Date("2026-03-01"));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("SCORED recovery with no parseable data"),
    );

    warnSpy.mockRestore();
  });
});

describe("WhoopProvider.sync() — workout collection from cycles", () => {
  it("collects workouts from strain.workouts fallback", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: futureExpiry,
      scopes: "userId:42",
    });

    const cycles = [
      {
        days: ["2026-03-01"],
        recovery: null,
        sleep: null,
        strain: {
          workouts: [
            {
              activity_id: "w-1",
              during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
              timezone_offset: "-05:00",
              sport_id: 0,
              score: 10,
              average_heart_rate: 150,
              max_heart_rate: 180,
              kilojoules: 2000,
            },
          ],
        },
      },
    ];

    const mockFetch = makeSyncMockFetch({
      cycles,
      weightliftingData: null,
      journalData: [],
      hrValues: [],
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");
    expect(result.recordsSynced).toBeGreaterThanOrEqual(0);

    // Verify the activity values contain correct fields from the workout
    const valuesCallArgs = getValuesCallArgs(db);
    const activityInsert = findValuesRecord(
      valuesCallArgs,
      (rec) => rec.externalId === "w-1" && rec.activityType !== undefined,
    );
    expect(activityInsert).toBeDefined();
    expect(activityInsert?.providerId).toBe("whoop");
    expect(activityInsert?.activityType).toBe("running"); // sport_id 0 = running
    expect(activityInsert?.startedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
    expect(activityInsert?.endedAt).toEqual(new Date("2026-03-01T11:00:00Z"));
    expect(activityInsert?.percentRecorded).toBeUndefined(); // no percent_recorded in test data
    // Verify raw data contains strain, HR, calories, duration
    expect(activityInsert?.raw).toBeDefined();
    expect(isRecord(activityInsert?.raw)).toBe(true);
    if (isRecord(activityInsert?.raw)) {
      expect(activityInsert.raw.strain).toBe(10);
      expect(activityInsert.raw.avgHeartRate).toBe(150);
      expect(activityInsert.raw.maxHeartRate).toBe(180);
      expect(activityInsert.raw.calories).toBe(478); // 2000 kJ / 4.184
      expect(activityInsert.raw.durationSeconds).toBe(3600);
    }

    // Verify onConflictDoUpdate was called with correct target and set for the activity upsert
    const conflictArgs = getOnConflictArgs(db);
    expect(conflictArgs.length).toBeGreaterThanOrEqual(1);
    const activityConflict = findOnConflictRecord(conflictArgs, (rec) => {
      return isRecord(rec.set) && "activityType" in rec.set && "percentRecorded" in rec.set;
    });
    expect(activityConflict).toBeDefined();
    // target should be an array (providerId + externalId columns)
    expect(Array.isArray(activityConflict?.target)).toBe(true);
    if (Array.isArray(activityConflict?.target)) {
      expect(activityConflict.target.length).toBe(3);
    }
    // set should contain all updatable fields
    expect(isRecord(activityConflict?.set)).toBe(true);
    if (isRecord(activityConflict?.set)) {
      expect(activityConflict.set.activityType).toBe("running");
      expect(activityConflict.set.startedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
      expect(activityConflict.set.endedAt).toEqual(new Date("2026-03-01T11:00:00Z"));
      expect(activityConflict.set.raw).toBeDefined();
      if (isRecord(activityConflict.set.raw)) {
        expect(activityConflict.set.raw.strain).toBe(10);
        expect(activityConflict.set.raw.avgHeartRate).toBe(150);
        expect(activityConflict.set.raw.maxHeartRate).toBe(180);
      }
    }
  });
});

const defaultStrainFields = {
  total_effective_volume_kg: 0,
  raw_msk_strain_score: 0,
  scaled_msk_strain_score: 0,
  cardio_strain_score: 0,
  cardio_strain_contribution_percent: 0,
  msk_strain_contribution_percent: 0,
};

describe("parseWeightliftingWorkout — edge cases", () => {
  it("skips incomplete sets", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "act-1",
      user_id: 42,
      ...defaultStrainFields,
      zone_durations: {
        zone0_to10_duration: 0,
        zone10_to20_duration: 0,
        zone20_to30_duration: 0,
        zone30_to40_duration: 0,
        zone40_to50_duration: 0,
        zone50_to60_duration: 0,
        zone60_to70_duration: 0,
        zone70_to80_duration: 0,
        zone80_to90_duration: 0,
        zone90_to100_duration: 0,
      },
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 50,
                  number_of_reps: 10,
                  msk_total_volume_kg: 500,
                  time_in_seconds: 0,
                  during: "['2026-03-01T10:00:00Z','2026-03-01T10:00:01Z')",
                  complete: true,
                },
                {
                  weight_kg: 50,
                  number_of_reps: 8,
                  msk_total_volume_kg: 400,
                  time_in_seconds: 0,
                  during: "['2026-03-01T10:05:00Z','2026-03-01T10:05:01Z')",
                  complete: false, // incomplete, should be skipped
                },
              ],
              exercise_details: {
                exercise_id: "BENCHPRESS",
                name: "Bench Press",
                equipment: "BARBELL",
                exercise_type: "STRENGTH",
                muscle_groups: ["CHEST"],
                volume_input_format: "REPS",
              },
            },
          ],
        },
      ],
    };

    const parsed = parseWeightliftingWorkout(response);
    expect(parsed.exercises).toHaveLength(1);
    expect(parsed.exercises[0]?.sets).toHaveLength(1);
    expect(parsed.exercises[0]?.sets[0]?.weightKg).toBe(50);
    expect(parsed.exercises[0]?.sets[0]?.reps).toBe(10);
  });

  it("sets weightKg to null when weight is 0", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "act-2",
      user_id: 42,
      ...defaultStrainFields,
      zone_durations: {
        zone0_to10_duration: 0,
        zone10_to20_duration: 0,
        zone20_to30_duration: 0,
        zone30_to40_duration: 0,
        zone40_to50_duration: 0,
        zone50_to60_duration: 0,
        zone60_to70_duration: 0,
        zone70_to80_duration: 0,
        zone80_to90_duration: 0,
        zone90_to100_duration: 0,
      },
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 0,
                  number_of_reps: 0,
                  msk_total_volume_kg: 100,
                  time_in_seconds: 60,
                  during: "['2026-03-01T10:00:00Z','2026-03-01T10:00:01Z')",
                  complete: true,
                },
              ],
              exercise_details: {
                exercise_id: "PLANK",
                name: "Plank",
                equipment: "",
                exercise_type: "STRENGTH",
                muscle_groups: ["CORE"],
                volume_input_format: "TIME",
              },
            },
          ],
        },
      ],
    };

    const parsed = parseWeightliftingWorkout(response);
    expect(parsed.exercises[0]?.sets[0]?.weightKg).toBeNull();
    expect(parsed.exercises[0]?.sets[0]?.reps).toBeNull();
    expect(parsed.exercises[0]?.sets[0]?.durationSeconds).toBe(60);
    expect(parsed.exercises[0]?.equipment).toBeNull(); // empty string → null
  });

  it("handles empty workout_groups", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "act-3",
      user_id: 42,
      ...defaultStrainFields,
      zone_durations: {
        zone0_to10_duration: 0,
        zone10_to20_duration: 0,
        zone20_to30_duration: 0,
        zone30_to40_duration: 0,
        zone40_to50_duration: 0,
        zone50_to60_duration: 0,
        zone60_to70_duration: 0,
        zone70_to80_duration: 0,
        zone80_to90_duration: 0,
        zone90_to100_duration: 0,
      },
      workout_groups: [],
    };

    const parsed = parseWeightliftingWorkout(response);
    expect(parsed.exercises).toHaveLength(0);
    expect(parsed.activityId).toBe("act-3");
  });

  it("sets durationSeconds to null for non-TIME format exercises", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "act-4",
      user_id: 42,
      ...defaultStrainFields,
      zone_durations: {
        zone0_to10_duration: 0,
        zone10_to20_duration: 0,
        zone20_to30_duration: 0,
        zone30_to40_duration: 0,
        zone40_to50_duration: 0,
        zone50_to60_duration: 0,
        zone60_to70_duration: 0,
        zone70_to80_duration: 0,
        zone80_to90_duration: 0,
        zone90_to100_duration: 0,
      },
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 100,
                  number_of_reps: 5,
                  msk_total_volume_kg: 500,
                  time_in_seconds: 30,
                  during: "['2026-03-01T10:00:00Z','2026-03-01T10:00:01Z')",
                  complete: true,
                },
              ],
              exercise_details: {
                exercise_id: "SQUAT",
                name: "Squat",
                equipment: "BARBELL",
                exercise_type: "STRENGTH",
                muscle_groups: ["LEGS"],
                volume_input_format: "REPS",
              },
            },
          ],
        },
      ],
    };

    const parsed = parseWeightliftingWorkout(response);
    expect(parsed.exercises[0]?.sets[0]?.durationSeconds).toBeNull();
    expect(parsed.exercises[0]?.sets[0]?.weightKg).toBe(100);
    expect(parsed.exercises[0]?.sets[0]?.reps).toBe(5);
  });

  it("indexes exercises across multiple groups", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "act-5",
      user_id: 42,
      ...defaultStrainFields,
      zone_durations: {
        zone0_to10_duration: 0,
        zone10_to20_duration: 0,
        zone20_to30_duration: 0,
        zone30_to40_duration: 0,
        zone40_to50_duration: 0,
        zone50_to60_duration: 0,
        zone60_to70_duration: 0,
        zone70_to80_duration: 0,
        zone80_to90_duration: 0,
        zone90_to100_duration: 0,
      },
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 50,
                  number_of_reps: 10,
                  msk_total_volume_kg: 500,
                  time_in_seconds: 0,
                  during: "['2026-03-01T10:00:00Z','2026-03-01T10:00:01Z')",
                  complete: true,
                },
              ],
              exercise_details: {
                exercise_id: "BENCH",
                name: "Bench",
                equipment: "BARBELL",
                exercise_type: "STRENGTH",
                muscle_groups: ["CHEST"],
                volume_input_format: "REPS",
              },
            },
          ],
        },
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 80,
                  number_of_reps: 8,
                  msk_total_volume_kg: 640,
                  time_in_seconds: 0,
                  during: "['2026-03-01T10:10:00Z','2026-03-01T10:10:01Z')",
                  complete: true,
                },
              ],
              exercise_details: {
                exercise_id: "DEADLIFT",
                name: "Deadlift",
                equipment: "BARBELL",
                exercise_type: "STRENGTH",
                muscle_groups: ["BACK"],
                volume_input_format: "REPS",
              },
            },
          ],
        },
      ],
    };

    const parsed = parseWeightliftingWorkout(response);
    expect(parsed.exercises).toHaveLength(2);
    expect(parsed.exercises[0]?.exerciseIndex).toBe(0);
    expect(parsed.exercises[1]?.exerciseIndex).toBe(1);
  });
});

describe("parseJournalResponse — answer text extraction", () => {
  it("extracts answer text from answer field in nested answers", () => {
    const raw = [
      {
        date: "2026-03-01",
        answers: [{ name: "caffeine", answer: "2 cups" }],
      },
    ];
    const entries = parseJournalResponse(raw);
    expect(entries[0]?.answerText).toBe("2 cups");
  });

  it("extracts answer text from response field in nested answers", () => {
    const raw = [
      {
        date: "2026-03-01",
        answers: [{ name: "stress", response: "moderate" }],
      },
    ];
    const entries = parseJournalResponse(raw);
    expect(entries[0]?.answerText).toBe("moderate");
  });

  it("extracts answer text from value string in nested answers", () => {
    const raw = [
      {
        date: "2026-03-01",
        answers: [{ name: "supplement", value: "melatonin" }],
      },
    ];
    const entries = parseJournalResponse(raw);
    expect(entries[0]?.answerText).toBe("melatonin");
    // String value should not be a numeric
    expect(entries[0]?.answerNumeric).toBeNull();
  });

  it("handles flat entry with answer field", () => {
    const raw = [{ date: "2026-03-01", name: "note", answer: "good day" }];
    const entries = parseJournalResponse(raw);
    expect(entries[0]?.answerText).toBe("good day");
  });

  it("handles flat entry with type field as question name", () => {
    const raw = [{ date: "2026-03-01", type: "Sleep Quality", value: 8 }];
    const entries = parseJournalResponse(raw);
    expect(entries[0]?.question).toBe("sleep_quality");
    expect(entries[0]?.answerNumeric).toBe(8);
  });

  it("handles nested answers with impact field", () => {
    const raw = [
      {
        date: "2026-03-01",
        answers: [{ name: "alcohol", value: 0, impact: -0.5 }],
      },
    ];
    const entries = parseJournalResponse(raw);
    expect(entries[0]?.impactScore).toBe(-0.5);
  });

  it("handles nested answers with impact_score field", () => {
    const raw = [
      {
        date: "2026-03-01",
        answers: [{ name: "caffeine", value: 2, impact_score: 0.3 }],
      },
    ];
    const entries = parseJournalResponse(raw);
    expect(entries[0]?.impactScore).toBe(0.3);
  });

  it("handles nested answers with score field as numeric", () => {
    const raw = [
      {
        date: "2026-03-01",
        answers: [{ name: "mood", score: 7 }],
      },
    ];
    const entries = parseJournalResponse(raw);
    expect(entries[0]?.answerNumeric).toBe(7);
  });

  it("handles flat entry with impact field", () => {
    const raw = [{ date: "2026-03-01", name: "caffeine", value: 3, impact: 0.1 }];
    const entries = parseJournalResponse(raw);
    expect(entries[0]?.impactScore).toBe(0.1);
  });
});

// ============================================================
// Provider authSetup / getUserIdentity tests
// ============================================================

describe("WhoopProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config when env vars are set", () => {
    process.env.WHOOP_CLIENT_ID = "test-id";
    process.env.WHOOP_CLIENT_SECRET = "test-secret";
    const provider = new WhoopProvider();
    const setup = provider.authSetup();
    expect(setup).toBeDefined();
    expect(setup?.oauthConfig.clientId).toBe("test-id");
    expect(setup?.oauthConfig.scopes).toContain("read:profile");
    expect(setup?.exchangeCode).toBeTypeOf("function");
  });

  it("returns undefined when env vars are missing", () => {
    delete process.env.WHOOP_CLIENT_ID;
    delete process.env.WHOOP_CLIENT_SECRET;
    const provider = new WhoopProvider();
    expect(provider.authSetup()).toBeUndefined();
  });
});

describe("WhoopProvider.getUserIdentity()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns identity from profile API", async () => {
    process.env.WHOOP_CLIENT_ID = "test-id";
    process.env.WHOOP_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({
        user_id: 12345,
        email: "whoop@test.com",
        first_name: "John",
        last_name: "Doe",
      });
    };

    const provider = new WhoopProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup?.getUserIdentity) throw new Error("getUserIdentity not defined");
    const identity = await setup.getUserIdentity("test-token");
    expect(identity.providerAccountId).toBe("12345");
    expect(identity.email).toBe("whoop@test.com");
    expect(identity.name).toBe("John Doe");
  });

  it("handles missing name fields", async () => {
    process.env.WHOOP_CLIENT_ID = "test-id";
    process.env.WHOOP_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({ user_id: 99 });
    };

    const provider = new WhoopProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup?.getUserIdentity) throw new Error("getUserIdentity not defined");
    const identity = await setup.getUserIdentity("test-token");
    expect(identity.providerAccountId).toBe("99");
    expect(identity.email).toBeNull();
    expect(identity.name).toBeNull();
  });

  it("throws on API error", async () => {
    process.env.WHOOP_CLIENT_ID = "test-id";
    process.env.WHOOP_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Forbidden", { status: 403 });
    };

    const provider = new WhoopProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup?.getUserIdentity) throw new Error("getUserIdentity not defined");
    await expect(setup.getUserIdentity("bad-token")).rejects.toThrow(
      "Whoop profile API error (403)",
    );
  });
});

// ============================================================
// Sync flow tests — sleep, HR stream, journal
// ============================================================

describe("WhoopProvider.sync() — sleep sync", () => {
  /** Inline sleep record matching the BFF v0 cycle.sleeps format */
  function makeInlineSleep(overrides: Record<string, unknown> = {}) {
    return {
      during: "['2026-02-28T23:00:00Z','2026-03-01T06:30:00Z')",
      state: "complete",
      time_in_bed: 27000000,
      wake_duration: 1800000,
      light_sleep_duration: 10800000,
      slow_wave_sleep_duration: 7200000,
      rem_sleep_duration: 5400000,
      in_sleep_efficiency: 91.7,
      habitual_sleep_need: 28800000,
      debt_post: 1800000,
      need_from_strain: 900000,
      credit_from_naps: 0,
      significant: true,
      ...overrides,
    };
  }

  it("syncs inline sleep from cycle.sleeps array", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    const cycles = [
      {
        days: ["2026-03-01"],
        recovery: null,
        sleeps: [makeInlineSleep()],
        workouts: [],
      },
    ];

    const mockFetch = makeSyncMockFetch({
      cycles,
      journalData: [],
      hrValues: [],
      weightliftingData: null,
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    db.onConflictDoUpdate = vi.fn().mockReturnValue(db);
    db.returning = vi.fn().mockResolvedValue([]);
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    const valuesCallArgs = getValuesCallArgs(db);
    const sleepInsert = findValuesRecord(
      valuesCallArgs,
      (rec) => typeof rec.externalId === "string" && rec.sleepType !== undefined,
    );
    expect(sleepInsert).toBeDefined();
    expect(sleepInsert?.providerId).toBe("whoop");
    expect(sleepInsert?.startedAt).toEqual(new Date("2026-02-28T23:00:00Z"));
    expect(sleepInsert?.endedAt).toEqual(new Date("2026-03-01T06:30:00Z"));
    expect(sleepInsert?.deepMinutes).toBe(120);
    expect(sleepInsert?.remMinutes).toBe(90);
    expect(sleepInsert?.lightMinutes).toBe(180);
    expect(sleepInsert?.awakeMinutes).toBe(30);
    expect(sleepInsert?.sleepType).toBe("sleep");
    expect(sleepInsert?.efficiencyPct).toBeCloseTo(91.7);
  });

  it("skips incomplete (non-complete state) sleep records", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    const cycles = [
      {
        days: ["2026-03-01"],
        recovery: null,
        sleeps: [makeInlineSleep({ state: "pending" })],
        workouts: [],
      },
    ];

    const mockFetch = makeSyncMockFetch({
      cycles,
      journalData: [],
      hrValues: [],
      weightliftingData: null,
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    db.onConflictDoUpdate = vi.fn().mockReturnValue(db);
    db.returning = vi.fn().mockResolvedValue([]);
    await provider.sync(db, new Date("2026-03-01"));

    const valuesCallArgs = getValuesCallArgs(db);
    const sleepInsert = findValuesRecord(
      valuesCallArgs,
      (rec) => typeof rec.externalId === "string" && rec.sleepType !== undefined,
    );
    expect(sleepInsert).toBeUndefined();
  });

  it("skips cycles without sleeps array", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    const cycles = [
      {
        days: ["2026-03-01"],
        recovery: null,
        workouts: [],
        // No sleeps array
      },
    ];

    const mockFetch = makeSyncMockFetch({
      cycles,
      journalData: [],
      hrValues: [],
      weightliftingData: null,
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    db.onConflictDoUpdate = vi.fn().mockReturnValue(db);
    db.returning = vi.fn().mockResolvedValue([]);
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");
    const valuesCallArgs = getValuesCallArgs(db);
    const sleepInsert = findValuesRecord(
      valuesCallArgs,
      (rec) => typeof rec.externalId === "string" && rec.sleepType !== undefined,
    );
    expect(sleepInsert).toBeUndefined();
  });

  it("skips inline sleep records that fail schema validation", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    const { logger } = await import("../logger.ts");
    const warnSpy = vi.spyOn(logger, "warn");

    const cycles = [
      {
        days: ["2026-03-01"],
        recovery: null,
        sleeps: [{ invalid: "data" }], // Missing required fields
        workouts: [],
      },
    ];

    const mockFetch = makeSyncMockFetch({
      cycles,
      journalData: [],
      hrValues: [],
      weightliftingData: null,
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    db.onConflictDoUpdate = vi.fn().mockReturnValue(db);
    db.returning = vi.fn().mockResolvedValue([]);
    await provider.sync(db, new Date("2026-03-01"));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping inline sleep"));
    warnSpy.mockRestore();
  });

  it("skips inline sleep with invalid timestamps and logs a warning", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    const { logger } = await import("../logger.ts");
    const warnSpy = vi.spyOn(logger, "warn");

    const cycles = [
      {
        days: ["2026-03-01"],
        recovery: null,
        sleeps: [
          {
            during: "invalid-range",
            state: "complete",
            time_in_bed: 27000000,
            wake_duration: 1800000,
            light_sleep_duration: 10800000,
            slow_wave_sleep_duration: 7200000,
            rem_sleep_duration: 5400000,
          },
        ],
        workouts: [],
      },
    ];

    const mockFetch = makeSyncMockFetch({
      cycles,
      journalData: [],
      hrValues: [],
      weightliftingData: null,
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    db.onConflictDoUpdate = vi.fn().mockReturnValue(db);
    db.returning = vi.fn().mockResolvedValue([]);
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");

    // No sleep insert should have occurred
    const valuesCallArgs = getValuesCallArgs(db);
    const sleepInsert = findValuesRecord(
      valuesCallArgs,
      (rec) => typeof rec.externalId === "string" && rec.sleepType !== undefined,
    );
    expect(sleepInsert).toBeUndefined();

    // Warning should be logged
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping inline sleep"));

    warnSpy.mockRestore();
  });
});

describe("WhoopProvider.sync() — HR stream sync", () => {
  it("syncs heart rate data in batches", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    const hrValues = [
      { time: 1709251200000, data: 72 },
      { time: 1709251206000, data: 75 },
      { time: 1709251212000, data: 78 },
    ];

    const mockFetch = makeSyncMockFetch({
      cycles: [],
      hrValues,
      journalData: [],
      weightliftingData: null,
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    db.onConflictDoUpdate = vi.fn().mockReturnValue(db);
    db.returning = vi.fn().mockResolvedValue([]);
    // Use a "since" very close to now so that only one HR window is fetched
    const since = new Date(Date.now() - 1000);
    const result = await provider.sync(db, since);

    expect(result.provider).toBe("whoop");
    expect(result.recordsSynced).toBeGreaterThanOrEqual(3);

    // Verify sensor_sample batch insert with correct HR values
    const valuesCallArgs = getValuesCallArgs(db);
    const hrBatch = findValuesBatch(
      valuesCallArgs,
      (arr) => arr[0]?.channel === "heart_rate" && typeof arr[0]?.scalar === "number",
    );
    expect(hrBatch).toBeDefined();
    expect(hrBatch).toHaveLength(3);
    expect(hrBatch?.[0]?.providerId).toBe("whoop");
    expect(hrBatch?.[0]?.scalar).toBe(72);
    expect(hrBatch?.[0]?.recordedAt).toEqual(new Date(1709251200000));
    expect(hrBatch?.[1]?.scalar).toBe(75);
    expect(hrBatch?.[2]?.scalar).toBe(78);

    // Verify withSyncLog was called with "hr_stream" as the type
    const { withSyncLog } = await import("../db/sync-log.ts");
    const syncLogCalls = vi.mocked(withSyncLog).mock.calls;
    const hrStreamCall = syncLogCalls.find((call: unknown[]) => call[2] === "hr_stream");
    expect(hrStreamCall).toBeDefined();
    expect(hrStreamCall?.[1]).toBe("whoop"); // provider id
  });

  it("batches HR data into chunks of 500", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    // Generate 750 HR values to force 2 batches (500 + 250)
    const hrValues: { time: number; data: number }[] = [];
    for (let i = 0; i < 750; i++) {
      hrValues.push({ time: 1709251200000 + i * 6000, data: 60 + (i % 40) });
    }

    const mockFetch = makeSyncMockFetch({
      cycles: [],
      hrValues,
      journalData: [],
      weightliftingData: null,
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    db.onConflictDoUpdate = vi.fn().mockReturnValue(db);
    db.returning = vi.fn().mockResolvedValue([]);
    const since = new Date(Date.now() - 1000);
    const result = await provider.sync(db, since);

    expect(result.provider).toBe("whoop");
    expect(result.recordsSynced).toBeGreaterThanOrEqual(750);

    // Find all HR batch inserts (arrays of heart_rate sensor rows)
    const valuesCallArgs = getValuesCallArgs(db);
    const hrBatches = valuesCallArgs.filter(
      (arg) =>
        isRecordArray(arg) &&
        arg[0]?.channel === "heart_rate" &&
        typeof arg[0]?.scalar === "number",
    );

    expect(hrBatches.length).toBeGreaterThanOrEqual(1);
    // Total should be 750
    const totalHrRecords = hrBatches.reduce(
      (sum: number, batch: unknown) => sum + (Array.isArray(batch) ? batch.length : 0),
      0,
    );
    expect(totalHrRecords).toBe(750);
  });

  it("handles empty HR data", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    const mockFetch = makeSyncMockFetch({
      cycles: [],
      hrValues: [],
      journalData: [],
      weightliftingData: null,
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    db.onConflictDoUpdate = vi.fn().mockReturnValue(db);
    db.returning = vi.fn().mockResolvedValue([]);
    const since = new Date(Date.now() - 1000);
    const result = await provider.sync(db, since);

    expect(result.provider).toBe("whoop");
    // No HR batch inserts should have happened
    const valuesCallArgs = getValuesCallArgs(db);
    const hrBatch = findValuesBatch(valuesCallArgs, (arr) => typeof arr[0]?.heartRate === "number");
    expect(hrBatch).toBeUndefined();
  });
});

describe("WhoopProvider.sync() — journal sync", () => {
  it("syncs journal entries", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    const journalData = [
      {
        date: "2026-03-01",
        answers: [
          { name: "caffeine", value: 2, impact: 0.3 },
          { name: "alcohol", answer: "none", impact: -0.1 },
        ],
      },
    ];

    const mockFetch = makeSyncMockFetch({
      cycles: [],
      hrValues: [],
      journalData,
      weightliftingData: null,
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");
    // Journal phase should produce 2 records (2 answers)
    expect(result.recordsSynced).toBeGreaterThanOrEqual(2);
    // Duration should be a small positive number (Date.now() - start), not huge (Date.now() + start)
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(30000); // less than 30s for a test

    // Verify journal entry inserts
    const valuesCallArgs = getValuesCallArgs(db);
    const caffeineInsert = findValuesRecord(
      valuesCallArgs,
      (rec) => rec.questionSlug === "caffeine",
    );
    expect(caffeineInsert).toBeDefined();
    expect(caffeineInsert?.providerId).toBe("whoop");
    expect(caffeineInsert?.date).toBe("2026-03-01");
    expect(caffeineInsert?.answerNumeric).toBe(2);
    expect(caffeineInsert?.impactScore).toBe(0.3);
    // Verify userId is set to the default fallback UUID
    expect(caffeineInsert?.userId).toBe("00000000-0000-0000-0000-000000000001");

    const alcoholInsert = findValuesRecord(valuesCallArgs, (rec) => rec.questionSlug === "alcohol");
    expect(alcoholInsert).toBeDefined();
    expect(alcoholInsert?.answerText).toBe("none");
    expect(alcoholInsert?.impactScore).toBe(-0.1);
    expect(alcoholInsert?.userId).toBe("00000000-0000-0000-0000-000000000001");

    // Verify journalQuestion inserts with correct category, dataType, and displayName
    const caffeineQuestion = findValuesRecord(
      valuesCallArgs,
      (rec) => rec.slug === "caffeine" && rec.category !== undefined,
    );
    expect(caffeineQuestion).toBeDefined();
    expect(caffeineQuestion?.category).toBe("custom");
    expect(caffeineQuestion?.dataType).toBe("numeric");
    // displayName should be "Caffeine" (snake_case → Title Case)
    expect(caffeineQuestion?.displayName).toBe("Caffeine");

    const alcoholQuestion = findValuesRecord(
      valuesCallArgs,
      (rec) => rec.slug === "alcohol" && rec.category !== undefined,
    );
    expect(alcoholQuestion).toBeDefined();
    expect(alcoholQuestion?.category).toBe("custom");
    expect(alcoholQuestion?.dataType).toBe("numeric");
    expect(alcoholQuestion?.displayName).toBe("Alcohol");

    // Verify onConflictDoUpdate was called for journal entries with correct target and set
    const conflictArgs = getOnConflictArgs(db);
    const journalConflict = findOnConflictRecord(conflictArgs, (rec) => {
      return (
        isRecord(rec.set) &&
        "answerText" in rec.set &&
        "answerNumeric" in rec.set &&
        "impactScore" in rec.set
      );
    });
    expect(journalConflict).toBeDefined();
    // target should have 4 columns: userId, date, questionSlug, providerId
    expect(Array.isArray(journalConflict?.target)).toBe(true);
    if (Array.isArray(journalConflict?.target)) {
      expect(journalConflict.target.length).toBe(4);
    }
    // set should have the updatable fields
    expect(isRecord(journalConflict?.set)).toBe(true);
    if (isRecord(journalConflict?.set)) {
      expect("answerText" in journalConflict.set).toBe(true);
      expect("answerNumeric" in journalConflict.set).toBe(true);
      expect("impactScore" in journalConflict.set).toBe(true);
    }
  });

  it("formats multi-word snake_case question names to Title Case", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    const journalData = [
      {
        date: "2026-03-01",
        answers: [{ name: "sleep_quality", value: 8 }],
      },
    ];

    const mockFetch = makeSyncMockFetch({
      cycles: [],
      hrValues: [],
      journalData,
      weightliftingData: null,
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    db.onConflictDoUpdate = vi.fn().mockReturnValue(db);
    db.returning = vi.fn().mockResolvedValue([]);
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    // Verify displayName converts snake_case to Title Case via replace(/_/g, " ") then \b\w → toUpperCase
    const valuesCallArgs = getValuesCallArgs(db);
    const questionInsert = findValuesRecord(
      valuesCallArgs,
      (rec) => rec.slug === "sleep_quality" && rec.category !== undefined,
    );
    expect(questionInsert).toBeDefined();
    expect(questionInsert?.displayName).toBe("Sleep Quality");
    expect(questionInsert?.category).toBe("custom");
    expect(questionInsert?.dataType).toBe("numeric");
  });

  it("uses provided userId from sync options", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    const journalData = [
      {
        date: "2026-03-01",
        answers: [{ name: "caffeine", value: 1 }],
      },
    ];

    const mockFetch = makeSyncMockFetch({
      cycles: [],
      hrValues: [],
      journalData,
      weightliftingData: null,
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    db.onConflictDoUpdate = vi.fn().mockReturnValue(db);
    db.returning = vi.fn().mockResolvedValue([]);
    const customUserId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const result = await provider.sync(db, new Date("2026-03-01"), { userId: customUserId });

    expect(result.provider).toBe("whoop");

    // Verify the journal entry was inserted with the custom userId, not the default
    const valuesCallArgs = getValuesCallArgs(db);
    const journalInsert = findValuesRecord(
      valuesCallArgs,
      (rec) => rec.questionSlug === "caffeine" && rec.userId !== undefined,
    );
    expect(journalInsert).toBeDefined();
    expect(journalInsert?.userId).toBe(customUserId);
  });

  it("records error when journal fetch fails", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    const mockFetch = makeSyncMockFetch({
      cycles: [],
      hrValues: [],
      journalError: true,
      weightliftingData: null,
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    db.onConflictDoUpdate = vi.fn().mockReturnValue(db);
    db.returning = vi.fn().mockResolvedValue([]);
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");
    const journalError = result.errors.find((e) => e.message.includes("journal"));
    expect(journalError).toBeDefined();
  });
});

describe("WhoopProvider.sync() — strength sync", () => {
  it("syncs weightlifting exercises and sets from workouts", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    const cycles = [
      {
        days: ["2026-03-01"],
        recovery: null,
        sleep: null,
        workouts: [
          {
            activity_id: "w-str-1",
            during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
            timezone_offset: "-05:00",
            sport_id: 0,
            score: 10,
            average_heart_rate: 130,
            max_heart_rate: 160,
            kilojoules: 1500,
          },
        ],
      },
    ];

    const weightliftingData: WhoopWeightliftingWorkoutResponse = {
      activity_id: "w-str-1",
      user_id: 42,
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
      total_effective_volume_kg: 0,
      raw_msk_strain_score: 0,
      scaled_msk_strain_score: 0,
      cardio_strain_score: 0,
      cardio_strain_contribution_percent: 0,
      msk_strain_contribution_percent: 0,
      zone_durations: {
        zone0_to10_duration: 0,
        zone10_to20_duration: 0,
        zone20_to30_duration: 0,
        zone30_to40_duration: 0,
        zone40_to50_duration: 0,
        zone50_to60_duration: 0,
        zone60_to70_duration: 0,
        zone70_to80_duration: 0,
        zone80_to90_duration: 0,
        zone90_to100_duration: 0,
      },
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 60,
                  number_of_reps: 10,
                  msk_total_volume_kg: 600,
                  time_in_seconds: 0,
                  during: "['2026-03-01T10:05:00Z','2026-03-01T10:05:30Z')",
                  complete: true,
                },
                {
                  weight_kg: 60,
                  number_of_reps: 8,
                  msk_total_volume_kg: 480,
                  time_in_seconds: 0,
                  during: "['2026-03-01T10:08:00Z','2026-03-01T10:08:30Z')",
                  complete: true,
                },
              ],
              exercise_details: {
                exercise_id: "BENCHPRESS",
                name: "Bench Press",
                equipment: "BARBELL",
                exercise_type: "STRENGTH",
                muscle_groups: ["CHEST"],
                volume_input_format: "REPS",
              },
            },
          ],
        },
      ],
    };

    const mockFetch = makeSyncMockFetch({
      cycles,
      weightliftingData,
      journalData: [],
      hrValues: [],
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    // The chain mock methods return the chain object. Use mockResolvedValueOnce
    // on the original chain mocks (accessible via db before override) to queue
    // specific return values that take priority over the default mockReturnValue.
    //
    // Sync calls these in order:
    // 1. Recovery: insert().values().onConflictDoUpdate() — no recovery here
    // 2. Workouts: insert().values().onConflictDoUpdate() — 1 workout
    // 3. Strength: insert().values().onConflictDoUpdate().returning() — needs workout ID
    //    then select().from().where().limit() — needs exercise ID
    //
    // Queue returning() to return workout UUID on the strength_workout insert.
    // The first returning() call is from the workout activity insert — returns []
    // (no ID needed). The second is from strength_workout insert.
    db.onConflictDoUpdate.mockReturnValueOnce(db).mockReturnValueOnce(db);
    // First onConflictDoUpdate is the activity workout insert (doesn't use returning)
    // The workout insert chain is: insert().values().onConflictDoUpdate()
    // The strength_workout insert chain is: insert().values().onConflictDoUpdate().returning()
    db.returning.mockResolvedValueOnce([{ id: "workout-uuid-1" }]);
    // select().from().where().limit() for exercise lookup
    db.limit.mockResolvedValueOnce([{ id: "exercise-uuid-1" }]);
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");
    // Should have synced the strength workout (1 strength record)
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    // Verify strength_workout upsert (providerId + externalId)
    const valuesCallArgs = getValuesCallArgs(db);
    const strengthWorkoutInsert = findValuesRecord(
      valuesCallArgs,
      (rec) => rec.externalId === "w-str-1" && rec.startedAt !== undefined && "name" in rec,
    );
    expect(strengthWorkoutInsert).toBeDefined();
    expect(strengthWorkoutInsert?.providerId).toBe("whoop");
    expect(strengthWorkoutInsert?.startedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
    expect(strengthWorkoutInsert?.endedAt).toEqual(new Date("2026-03-01T11:00:00Z"));
    // Verify name field uses ?? null (weightliftingData.name is undefined, so should be null)
    expect(strengthWorkoutInsert?.name).toBeNull();

    // Verify onConflictDoUpdate was called for strength_workout with correct target and set
    const conflictArgs = getOnConflictArgs(db);
    const strengthConflict = findOnConflictRecord(conflictArgs, (rec) => {
      return isRecord(rec.set) && "rawMskStrainScore" in rec.set && "startedAt" in rec.set;
    });
    expect(strengthConflict).toBeDefined();
    // target should be an array (providerId + externalId)
    expect(Array.isArray(strengthConflict?.target)).toBe(true);
    if (Array.isArray(strengthConflict?.target)) {
      expect(strengthConflict.target.length).toBe(3);
    }
    // set should contain the updatable fields
    expect(isRecord(strengthConflict?.set)).toBe(true);
    if (isRecord(strengthConflict?.set)) {
      expect(strengthConflict.set.startedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
      expect(strengthConflict.set.endedAt).toEqual(new Date("2026-03-01T11:00:00Z"));
      expect(strengthConflict.set.name).toBeNull();
      expect(strengthConflict.set.rawMskStrainScore).toBe(0);
      expect(strengthConflict.set.scaledMskStrainScore).toBe(0);
      expect(strengthConflict.set.cardioStrainScore).toBe(0);
    }

    // Verify returning was called with { id: ... } argument
    expect(db.returning).toHaveBeenCalled();
    const returningCallArgs = db.returning.mock.calls;
    // Find the returning call with an id field
    const returningWithId = returningCallArgs.find(
      (call: unknown[]) => isRecord(call[0]) && "id" in call[0],
    );
    expect(returningWithId).toBeDefined();
    if (Array.isArray(returningWithId) && returningWithId.length > 0) {
      expect(returningWithId[0]).toHaveProperty("id");
    }

    // Verify exercise alias insert happened
    const exerciseAliasInsert = findValuesRecord(
      valuesCallArgs,
      (rec) =>
        rec.exerciseId === "exercise-uuid-1" &&
        rec.providerExerciseId === "BENCHPRESS" &&
        rec.providerId === "whoop",
    );
    expect(exerciseAliasInsert).toBeDefined();
    expect(exerciseAliasInsert?.providerExerciseName).toBe("Bench Press");

    // Verify onConflictDoNothing was called (for exercise and exercise alias)
    expect(db.onConflictDoNothing).toHaveBeenCalled();

    // Verify exercise upsert
    const exerciseInsert = findValuesRecord(
      valuesCallArgs,
      (rec) => rec.name === "Bench Press" && rec.equipment === "BARBELL",
    );
    expect(exerciseInsert).toBeDefined();
    expect(exerciseInsert?.muscleGroups).toEqual(["CHEST"]);
    expect(exerciseInsert?.exerciseType).toBe("STRENGTH");

    // Verify strength set batch insert (2 complete sets)
    const setInsert = findValuesBatch(
      valuesCallArgs,
      (arr) => arr.length === 2 && typeof arr[0]?.weightKg === "number",
    );
    expect(setInsert).toBeDefined();
    expect(setInsert?.[0]?.workoutId).toBe("workout-uuid-1");
    expect(setInsert?.[0]?.exerciseId).toBe("exercise-uuid-1");
    expect(setInsert?.[0]?.weightKg).toBe(60);
    expect(setInsert?.[0]?.reps).toBe(10);
    expect(setInsert?.[0]?.setIndex).toBe(0);
    expect(setInsert?.[0]?.setType).toBe("working");
    expect(setInsert?.[1]?.weightKg).toBe(60);
    expect(setInsert?.[1]?.reps).toBe(8);
    expect(setInsert?.[1]?.setIndex).toBe(1);
    // Verify setRows.length > 0 actually triggered the insert (2 sets is > 0)
    expect(setInsert).toHaveLength(2);

    // Verify delete was called (to clear old sets before re-inserting)
    expect(db.delete).toHaveBeenCalled();
  });

  it("uses workout name from weightlifting data when available", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    const cycles = [
      {
        days: ["2026-03-01"],
        recovery: null,
        sleep: null,
        workouts: [
          {
            activity_id: "w-named-1",
            during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
            timezone_offset: "-05:00",
            sport_id: 0,
            score: 8,
            average_heart_rate: 125,
            max_heart_rate: 155,
            kilojoules: 1200,
          },
        ],
      },
    ];

    const weightliftingData: WhoopWeightliftingWorkoutResponse = {
      activity_id: "w-named-1",
      user_id: 42,
      name: "Morning Push Day",
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
      total_effective_volume_kg: 0,
      raw_msk_strain_score: 5.2,
      scaled_msk_strain_score: 3.1,
      cardio_strain_score: 2.0,
      cardio_strain_contribution_percent: 40,
      msk_strain_contribution_percent: 60,
      zone_durations: {
        zone0_to10_duration: 0,
        zone10_to20_duration: 0,
        zone20_to30_duration: 0,
        zone30_to40_duration: 0,
        zone40_to50_duration: 0,
        zone50_to60_duration: 0,
        zone60_to70_duration: 0,
        zone70_to80_duration: 0,
        zone80_to90_duration: 0,
        zone90_to100_duration: 0,
      },
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 40,
                  number_of_reps: 12,
                  msk_total_volume_kg: 480,
                  time_in_seconds: 0,
                  during: "['2026-03-01T10:05:00Z','2026-03-01T10:05:30Z')",
                  complete: true,
                },
              ],
              exercise_details: {
                exercise_id: "DUMBBELL_PRESS",
                name: "Dumbbell Press",
                equipment: "DUMBBELL",
                exercise_type: "STRENGTH",
                muscle_groups: ["CHEST"],
                volume_input_format: "REPS",
              },
            },
          ],
        },
      ],
    };

    const mockFetch = makeSyncMockFetch({
      cycles,
      weightliftingData,
      journalData: [],
      hrValues: [],
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    db.onConflictDoUpdate.mockReturnValueOnce(db).mockReturnValueOnce(db);
    db.returning.mockResolvedValueOnce([{ id: "workout-uuid-named" }]);
    db.limit.mockResolvedValueOnce([{ id: "exercise-uuid-named" }]);
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    // Verify the strength_workout insert has the workout name (not null)
    const valuesCallArgs = getValuesCallArgs(db);
    const namedWorkoutInsert = findValuesRecord(
      valuesCallArgs,
      (rec) => rec.externalId === "w-named-1" && "name" in rec && rec.startedAt !== undefined,
    );
    expect(namedWorkoutInsert).toBeDefined();
    // name should be "Morning Push Day" (not null, not && null)
    expect(namedWorkoutInsert?.name).toBe("Morning Push Day");
    expect(namedWorkoutInsert?.rawMskStrainScore).toBe(5.2);
    expect(namedWorkoutInsert?.scaledMskStrainScore).toBe(3.1);
    expect(namedWorkoutInsert?.mskStrainContributionPercent).toBe(60);

    // Verify the onConflictDoUpdate set also has the name
    const conflictArgs = getOnConflictArgs(db);
    const namedConflict = findOnConflictRecord(conflictArgs, (rec) => {
      return isRecord(rec.set) && rec.set.name === "Morning Push Day";
    });
    expect(namedConflict).toBeDefined();
  });

  it("skips exercise/set processing when returning yields no workoutId", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    const cycles = [
      {
        days: ["2026-03-01"],
        recovery: null,
        sleep: null,
        workouts: [
          {
            activity_id: "w-no-id",
            during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
            timezone_offset: "-05:00",
            sport_id: 0,
            score: 5,
            average_heart_rate: 120,
            max_heart_rate: 150,
            kilojoules: 1000,
          },
        ],
      },
    ];

    const weightliftingData: WhoopWeightliftingWorkoutResponse = {
      activity_id: "w-no-id",
      user_id: 42,
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
      total_effective_volume_kg: 0,
      raw_msk_strain_score: 0,
      scaled_msk_strain_score: 0,
      cardio_strain_score: 0,
      cardio_strain_contribution_percent: 0,
      msk_strain_contribution_percent: 0,
      zone_durations: {
        zone0_to10_duration: 0,
        zone10_to20_duration: 0,
        zone20_to30_duration: 0,
        zone30_to40_duration: 0,
        zone40_to50_duration: 0,
        zone50_to60_duration: 0,
        zone60_to70_duration: 0,
        zone70_to80_duration: 0,
        zone80_to90_duration: 0,
        zone90_to100_duration: 0,
      },
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 50,
                  number_of_reps: 10,
                  msk_total_volume_kg: 500,
                  time_in_seconds: 0,
                  during: "['2026-03-01T10:05:00Z','2026-03-01T10:05:30Z')",
                  complete: true,
                },
              ],
              exercise_details: {
                exercise_id: "SQUAT",
                name: "Squat",
                equipment: "BARBELL",
                exercise_type: "STRENGTH",
                muscle_groups: ["LEGS"],
                volume_input_format: "REPS",
              },
            },
          ],
        },
      ],
    };

    const mockFetch = makeSyncMockFetch({
      cycles,
      weightliftingData,
      journalData: [],
      hrValues: [],
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    // Activity workout insert gets one conflict, strength_workout gets another
    db.onConflictDoUpdate.mockReturnValueOnce(db).mockReturnValueOnce(db);
    // returning() yields empty array → row?.id is undefined → !workoutId is true → skip
    db.returning.mockResolvedValueOnce([]);
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");
    // No set inserts should happen since workoutId was not returned
    const valuesCallArgs = getValuesCallArgs(db);
    const setBatch = findValuesBatch(
      valuesCallArgs,
      (arr) => typeof arr[0]?.weightKg === "number" && typeof arr[0]?.setIndex === "number",
    );
    expect(setBatch).toBeUndefined();
    // No exercise lookup should happen either (no select().from().where().limit() for exercise)
    // The test should complete without errors from the strength sync
    const strengthErrors = result.errors.filter((e) => e.message.includes("Strength"));
    expect(strengthErrors).toHaveLength(0);
  });

  it("skips workouts with no weightlifting data (404)", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "test",
      refreshToken: "test-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "userId:42",
    });

    const cycles = [
      {
        days: ["2026-03-01"],
        recovery: null,
        sleep: null,
        workouts: [
          {
            activity_id: "w-cardio-1",
            during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
            timezone_offset: "-05:00",
            sport_id: 0,
            score: 10,
            average_heart_rate: 150,
            max_heart_rate: 180,
            kilojoules: 2000,
          },
        ],
      },
    ];

    // weightliftingData: null triggers 404 in mockFetch
    const mockFetch = makeSyncMockFetch({
      cycles,
      weightliftingData: null,
      journalData: [],
      hrValues: [],
    });
    const provider = new WhoopProvider(mockFetch);
    const db = makeChainableMock();
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("whoop");
    // No strength-specific errors
    const strengthErrors = result.errors.filter((e) => e.message.includes("Strength"));
    expect(strengthErrors).toHaveLength(0);

    // Verify no strength_workout insert happened (no insert with name field that isn't a journal)
    const valuesCallArgs = getValuesCallArgs(db);
    const strengthWorkoutInsert = findValuesRecord(
      valuesCallArgs,
      (rec) =>
        rec.externalId === "w-cardio-1" && rec.name !== undefined && rec.startedAt !== undefined,
    );
    expect(strengthWorkoutInsert).toBeUndefined();
  });
});
