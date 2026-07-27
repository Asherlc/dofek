import { GarminApiError, GarminRateLimitError } from "@dofek/garmin-connect/client";
import type { GarminTokens } from "@dofek/garmin-connect/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenSet } from "../auth/oauth.ts";
import { eachDay, formatDate } from "./garmin/date-utils.ts";
import {
  deserializeInternalTokens,
  INTERNAL_SCOPE_MARKER,
  serializeInternalTokens,
} from "./garmin/internal-tokens.ts";
import { GarminProvider } from "./garmin/provider.ts";
import type { GarminSyncStep } from "./garmin/sync-checkpoint.ts";
import { createGarminSyncCheckpoint } from "./garmin/sync-checkpoint.ts";
import { planGarminSyncSteps } from "./garmin/sync-step-plan.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { makeTransactionalTestDatabase } from "./test-helpers.ts";
import type { SyncOptions } from "./types.ts";

vi.mock("../db/provider-data-deletion.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

const drizzleMocks = vi.hoisted<{
  inArrayValues: unknown[];
}>(() => ({
  inArrayValues: [],
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    inArray: (...args: Parameters<typeof actual.inArray>) => {
      drizzleMocks.inArrayValues.push(args[1]);
      return actual.inArray(...args);
    },
  };
});

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "00000000-0000-0000-0000-000000000001",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

const { publishedMetricStreamBatches } = vi.hoisted<{
  publishedMetricStreamBatches: Record<string, unknown>[][];
}>(() => ({
  publishedMetricStreamBatches: [],
}));

vi.mock("../metric-stream/redpanda-producer.ts", () => ({
  getDefaultMetricStreamEventPublisher: async () => ({
    publishRows: async (rows: readonly Record<string, unknown>[]) => {
      publishedMetricStreamBatches.push([...rows]);
      return rows.map((row, index) => ({
        version: 1,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        recordedAt: row.recordedAt instanceof Date ? row.recordedAt.toISOString() : row.recordedAt,
      }));
    },
  }),
}));

// ============================================================
// Hoisted mocks (must be before vi.mock calls)
// ============================================================

const mocks = vi.hoisted(() => {
  const client = {
    getActivities: vi.fn(),
    getSleepData: vi.fn(),
    getDailySummary: vi.fn(),
    getHrvSummary: vi.fn(),
    getTrainingStatus: vi.fn(),
    getDailyStress: vi.fn(),
    getDailyHeartRate: vi.fn(),
    getActivityDetail: vi.fn(),
    getTokens: vi.fn(),
  };

  return {
    client,
    signIn: vi.fn(),
    fromTokens: vi.fn(),
    parseConnectActivity: vi.fn(),
    parseConnectSleep: vi.fn(),
    parseConnectSleepStages: vi.fn().mockReturnValue([]),
    parseConnectDailySummary: vi.fn(),
    parseHrvSummary: vi.fn(),
    parseTrainingStatus: vi.fn(),
    parseStressTimeSeries: vi.fn(),
    parseHeartRateTimeSeries: vi.fn(),
    parseActivityDetail: vi.fn(),
    loadTokens: vi.fn(),
    saveTokens: vi.fn(),
    ensureProvider: vi.fn(),
    withSyncLog: vi.fn(),
  };
});

const providerActivityAbsenceMocks = vi.hoisted(() => ({
  markProviderActivityAbsent: vi.fn().mockResolvedValue(undefined),
  finishProviderActivityListSync: vi.fn().mockResolvedValue(undefined),
  upsertProviderActivity: vi.fn().mockResolvedValue({ id: "activity-id" }),
}));

const clickHouseMocks = vi.hoisted(() => {
  const query = vi.fn();
  const close = vi.fn();
  return {
    query,
    close,
    createClickHouseClientFromEnv: vi.fn(() => ({ query, close })),
  };
});

vi.mock("../db/clickhouse.ts", () => ({
  createClickHouseClientFromEnv: clickHouseMocks.createClickHouseClientFromEnv,
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
}));

vi.mock("@dofek/garmin-connect/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@dofek/garmin-connect/client")>();
  return {
    GarminApiError: original.GarminApiError,
    GarminRateLimitError: original.GarminRateLimitError,
    GarminConnectClient: {
      signIn: mocks.signIn,
      fromTokens: mocks.fromTokens,
    },
  };
});

vi.mock("@dofek/garmin-connect/parsing", () => ({
  parseConnectActivity: mocks.parseConnectActivity,
  parseConnectSleep: mocks.parseConnectSleep,
  parseConnectSleepStages: mocks.parseConnectSleepStages,
  parseConnectDailySummary: mocks.parseConnectDailySummary,
  parseHrvSummary: mocks.parseHrvSummary,
  parseTrainingStatus: mocks.parseTrainingStatus,
  parseStressTimeSeries: mocks.parseStressTimeSeries,
  parseHeartRateTimeSeries: mocks.parseHeartRateTimeSeries,
  parseActivityDetail: mocks.parseActivityDetail,
}));

vi.mock("../db/tokens.ts", () => ({
  loadTokens: mocks.loadTokens,
  saveTokens: mocks.saveTokens,
  ensureProvider: mocks.ensureProvider,
}));

vi.mock("../db/sync-log.ts", () => ({
  withSyncLog: mocks.withSyncLog,
}));

vi.mock("../db/provider-activity-sync.ts", () => ({
  markProviderActivityAbsent: providerActivityAbsenceMocks.markProviderActivityAbsent,
  finishProviderActivityListSync: providerActivityAbsenceMocks.finishProviderActivityListSync,
  upsertProviderActivity: providerActivityAbsenceMocks.upsertProviderActivity,
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const pendingQueryMocks = vi.hoisted(() => ({
  listPendingSyncRequestQueryKeys: vi.fn(async () => new Set<string>()),
}));

vi.mock("../lib/sync-request-queue.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sync-request-queue.ts")>();
  return {
    ...actual,
    listPendingSyncRequestQueryKeys: pendingQueryMocks.listPendingSyncRequestQueryKeys,
  };
});

vi.mock("../lib/provider-rate-limit-fetch.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/provider-rate-limit-fetch.ts")>();
  return {
    ...actual,
    createProviderRateLimitFetch: vi.fn(actual.createProviderRateLimitFetch),
  };
});

// ============================================================
// Test helpers
// ============================================================

function fakeGarminTokens(overrides?: { expiresAt?: number }): GarminTokens {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = overrides?.expiresAt ?? now + 3600;
  return {
    oauth1: {
      oauth_token: "test-oauth1-token",
      oauth_token_secret: "test-oauth1-secret",
    },
    oauth2: {
      scope: "CONNECT_READ CONNECT_WRITE",
      jti: "test-jti",
      token_type: "Bearer",
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expires_in: 3600,
      expires_at: expiresAt,
      refresh_token_expires_in: 7776000,
      refresh_token_expires_at: now + 7776000,
    },
  };
}

function fakeStoredTokens(overrides?: { expiresAt?: Date }): TokenSet {
  const tokens = fakeGarminTokens();
  return {
    accessToken: JSON.stringify(tokens),
    refreshToken: null,
    expiresAt: overrides?.expiresAt ?? new Date(Date.now() + 3600000),
    scopes: INTERNAL_SCOPE_MARKER,
  };
}

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
  onConflictDoNothing: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

function createMockDb(): MockDb {
  const db: MockDb = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn(),
    update: vi.fn(),
    set: vi.fn(),
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    returning: vi.fn().mockResolvedValue([{ id: "mock-session-id" }]),
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([]),
  };
  const whereResult = Object.assign(Promise.resolve([]), {
    limit: (...args: unknown[]) => db.limit(...args),
    returning: vi.fn().mockResolvedValue([{ date: "2026-03-01" }]),
  });
  db.select.mockReturnValue(db);
  db.from.mockReturnValue(db);
  db.where.mockReturnValue(whereResult);
  db.insert.mockReturnValue(db);
  db.update.mockReturnValue(db);
  db.set.mockReturnValue(db);
  db.values.mockReturnValue(db);
  db.onConflictDoUpdate.mockReturnValue(db);
  db.delete.mockReturnValue(db);
  return makeTransactionalTestDatabase(db);
}

async function planAllGarminSteps(
  db: MockDb,
  since: Date,
  until: Date,
  userId = "00000000-0000-0000-0000-000000000001",
): Promise<GarminSyncStep[]> {
  const dates = eachDay(since, until);
  return planGarminSyncSteps({
    db,
    providerId: "garmin",
    userId,
    sinceDate: formatDate(since),
    untilDate: formatDate(until),
    dates,
  });
}

// Typed wrapper to call provider.sync() with a mock DB.
// The mock DB duck-types SyncDatabase at runtime but cannot satisfy the
// Drizzle branded type at compile time, so we widen via bind().
function syncProvider(
  provider: GarminProvider,
  db: MockDb,
  since: Date,
  options?: SyncOptions & { until?: Date },
) {
  const { until, ...syncOptions } = options ?? {};
  return Reflect.apply(provider.sync, provider, [
    new SyncRun({
      db,
      window: SyncWindow.fromSince({ since, until: until ?? SyncWindow.now() }),
      ...syncOptions,
    }),
  ]) satisfies Promise<{
    provider: string;
    recordsSynced: number;
    errors: { message: string; cause?: unknown }[];
    duration: number;
  }>;
}

// ============================================================
// Pure functions: serializeInternalTokens
// ============================================================

describe("serializeInternalTokens", () => {
  it("serializes GarminTokens to a TokenSet", () => {
    const tokens = fakeGarminTokens();
    const result = serializeInternalTokens(tokens);

    expect(result.accessToken).toBe(JSON.stringify(tokens));
    expect(result.refreshToken).toBeNull();
    expect(result.expiresAt).toEqual(new Date(tokens.oauth2.expires_at * 1000));
    expect(result.scopes).toBe(INTERNAL_SCOPE_MARKER);
  });

  it("stores the full token blob as JSON in accessToken", () => {
    const tokens = fakeGarminTokens();
    const result = serializeInternalTokens(tokens);
    const parsed = JSON.parse(result.accessToken);
    expect(parsed.oauth1.oauth_token).toBe("test-oauth1-token");
    expect(parsed.oauth1.oauth_token_secret).toBe("test-oauth1-secret");
    expect(parsed.oauth2.access_token).toBe("test-access-token");
    expect(parsed.oauth2.refresh_token).toBe("test-refresh-token");
  });

  it("computes expiresAt from oauth2.expires_at epoch seconds", () => {
    const tokens = fakeGarminTokens({ expiresAt: 1700000000 });
    const result = serializeInternalTokens(tokens);
    expect(result.expiresAt).toEqual(new Date(1700000000 * 1000));
  });
});

// ============================================================
// Pure functions: deserializeInternalTokens
// ============================================================

describe("deserializeInternalTokens", () => {
  it("parses valid serialized tokens", () => {
    const original = fakeGarminTokens();
    const stored = serializeInternalTokens(original);
    const result = deserializeInternalTokens(stored);

    expect(result).not.toBeNull();
    expect(result?.oauth1.oauth_token).toBe("test-oauth1-token");
    expect(result?.oauth1.oauth_token_secret).toBe("test-oauth1-secret");
    expect(result?.oauth2.access_token).toBe("test-access-token");
    expect(result?.oauth2.refresh_token).toBe("test-refresh-token");
    expect(result?.oauth2.scope).toBe("CONNECT_READ CONNECT_WRITE");
    expect(result?.oauth2.jti).toBe("test-jti");
    expect(result?.oauth2.token_type).toBe("Bearer");
    expect(result?.oauth2.expires_in).toBe(3600);
    expect(result?.oauth2.refresh_token_expires_in).toBe(7776000);
  });

  it("returns null for non-JSON accessToken", () => {
    const stored: TokenSet = {
      accessToken: "plain-bearer-token",
      refreshToken: null,
      expiresAt: new Date(),
      scopes: "",
    };
    expect(deserializeInternalTokens(stored)).toBeNull();
  });

  it("returns null for JSON that does not match schema", () => {
    const stored: TokenSet = {
      accessToken: JSON.stringify({ foo: "bar" }),
      refreshToken: null,
      expiresAt: new Date(),
      scopes: "",
    };
    expect(deserializeInternalTokens(stored)).toBeNull();
  });

  it("returns null for JSON missing required oauth2 fields", () => {
    const stored: TokenSet = {
      accessToken: JSON.stringify({
        oauth1: { oauth_token: "t", oauth_token_secret: "s" },
        oauth2: { scope: "s" },
      }),
      refreshToken: null,
      expiresAt: new Date(),
      scopes: "",
    };
    expect(deserializeInternalTokens(stored)).toBeNull();
  });

  it("round-trips through serialize/deserialize", () => {
    const original = fakeGarminTokens();
    const stored = serializeInternalTokens(original);
    const result = deserializeInternalTokens(stored);
    expect(result).toEqual(original);
  });
});

// ============================================================
// Pure functions: formatDate
// ============================================================

describe("formatDate", () => {
  it("returns YYYY-MM-DD for a date", () => {
    expect(formatDate(new Date("2026-03-01T10:30:00Z"))).toBe("2026-03-01");
  });

  it("handles midnight UTC", () => {
    expect(formatDate(new Date("2026-01-15T00:00:00Z"))).toBe("2026-01-15");
  });

  it("handles end of year", () => {
    expect(formatDate(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31");
  });
});

// ============================================================
// Pure functions: eachDay
// ============================================================

describe("eachDay", () => {
  it("returns a single date for same-day range", () => {
    const result = eachDay(new Date("2026-03-01T10:00:00Z"), new Date("2026-03-01T23:00:00Z"));
    expect(result).toEqual(["2026-03-01"]);
  });

  it("returns multiple dates for multi-day range", () => {
    const result = eachDay(new Date("2026-03-01T00:00:00Z"), new Date("2026-03-03T00:00:00Z"));
    expect(result).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
  });

  it("returns empty array when since is after until", () => {
    const result = eachDay(new Date("2026-03-05T00:00:00Z"), new Date("2026-03-01T00:00:00Z"));
    expect(result).toEqual([]);
  });

  it("normalizes times to midnight UTC", () => {
    const result = eachDay(new Date("2026-03-01T15:30:00Z"), new Date("2026-03-02T04:15:00Z"));
    expect(result).toEqual(["2026-03-01", "2026-03-02"]);
  });

  it("includes both endpoints", () => {
    const result = eachDay(new Date("2026-06-10T00:00:00Z"), new Date("2026-06-12T00:00:00Z"));
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("2026-06-10");
    expect(result[2]).toBe("2026-06-12");
  });
});

// ============================================================
// Provider identity
// ============================================================

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
// Validation
// ============================================================

describe("GarminProvider.validate()", () => {
  it("always returns null (no env vars required)", () => {
    const provider = new GarminProvider();
    expect(provider.validate()).toBeNull();
  });
});

// ============================================================
// Auth setup
// ============================================================

describe("GarminProvider.authSetup()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("provides automatedLogin function", () => {
    const provider = new GarminProvider();
    const setup = provider.authSetup();
    expect(setup.automatedLogin).toBeTypeOf("function");
  });

  it("does not include oauthConfig (credential-only)", () => {
    const provider = new GarminProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig).toBeUndefined();
    expect(setup.exchangeCode).toBeUndefined();
  });

  it("automatedLogin calls GarminConnectClient.signIn with the provider's fetchFn", async () => {
    const customFetch = vi.fn<typeof globalThis.fetch>();
    customFetch.mockResolvedValue(new Response("ok"));
    const provider = new GarminProvider(customFetch);
    const setup = provider.authSetup();

    const tokens = fakeGarminTokens();
    mocks.signIn.mockResolvedValue({ tokens });

    if (!setup.automatedLogin) throw new Error("expected automatedLogin");
    const result = await setup.automatedLogin("user@test.com", "pass123");

    expect(mocks.signIn).toHaveBeenCalledWith(
      "user@test.com",
      "pass123",
      "garmin.com",
      expect.any(Function),
    );
    const forwardedFetch = mocks.signIn.mock.calls[0]?.[3];
    if (typeof forwardedFetch !== "function") throw new Error("expected forwarded fetch function");
    await forwardedFetch("https://example.com");
    expect(customFetch).toHaveBeenCalledWith("https://example.com", {
      signal: expect.any(AbortSignal),
    });
    expect(result.accessToken).toBe(JSON.stringify(tokens));
    expect(result.scopes).toBe(INTERNAL_SCOPE_MARKER);
  });

  // Grabs the rate-limit-aware fetch the provider forwarded into signIn, so we
  // can drive it with crafted responses to assert the createRateLimitError callback.
  async function getProviderRateLimitFetch(innerFetch: typeof globalThis.fetch) {
    const provider = new GarminProvider(innerFetch);
    const setup = provider.authSetup();
    mocks.signIn.mockResolvedValue({ tokens: fakeGarminTokens() });
    if (!setup.automatedLogin) throw new Error("expected automatedLogin");
    await setup.automatedLogin("user@test.com", "pass123");
    const forwardedFetch = mocks.signIn.mock.calls[0]?.[3];
    if (typeof forwardedFetch !== "function") throw new Error("expected forwarded fetch function");
    return forwardedFetch;
  }

  it("surfaces a 429 from the provider's fetch as a GarminRateLimitError", async () => {
    const customFetch = vi.fn<typeof globalThis.fetch>();
    customFetch.mockResolvedValue(
      new Response("slow down", { status: 429, headers: { "Retry-After": "120" } }),
    );

    const forwardedFetch = await getProviderRateLimitFetch(customFetch);
    const err = await forwardedFetch("https://example.com").catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(GarminRateLimitError);
    if (err instanceof GarminRateLimitError) {
      expect(err.providerId).toBe("garmin");
      expect(err.statusCode).toBe(429);
      expect(err.responseBody).toBe("slow down");
      expect(err.retryAfterSeconds).toBe(120);
      expect(err.message).toBe("Rate limit exceeded (429): slow down");
    }
  });

  it("guards against a 429 response that lacks a headers object", async () => {
    // The createRateLimitError callback uses optional chaining on response.headers
    // so a header-less response yields a GarminRateLimitError with no Retry-After.
    const innerFetch = vi
      .fn()
      .mockResolvedValue({ status: 429, headers: undefined, text: async () => "no headers" });

    const forwardedFetch = await getProviderRateLimitFetch(innerFetch);
    const err = await forwardedFetch("https://example.com").catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(GarminRateLimitError);
    if (err instanceof GarminRateLimitError) {
      expect(err.responseBody).toBe("no headers");
      expect(err.retryAfterSeconds).toBeNull();
    }
  });

  it("guards against a 429 response whose headers lack a get method", async () => {
    // Optional chaining on response.headers?.get guards a headers object without get().
    const innerFetch = vi
      .fn()
      .mockResolvedValue({ status: 429, headers: {}, text: async () => "no get" });

    const forwardedFetch = await getProviderRateLimitFetch(innerFetch);
    const err = await forwardedFetch("https://example.com").catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(GarminRateLimitError);
    if (err instanceof GarminRateLimitError) {
      expect(err.responseBody).toBe("no get");
      expect(err.retryAfterSeconds).toBeNull();
    }
  });

  async function getAuthFetchSetup(response?: Response) {
    const customFetch = vi.fn<typeof globalThis.fetch>();
    customFetch.mockResolvedValue(response ?? new Response("ok"));
    const provider = new GarminProvider(customFetch);
    const setup = provider.authSetup();
    mocks.signIn.mockResolvedValue({ tokens: fakeGarminTokens() });
    if (!setup.automatedLogin) throw new Error("expected automatedLogin");
    await setup.automatedLogin("user@test.com", "pass123");
    const forwardedFetch = mocks.signIn.mock.calls[0]?.[3];
    if (typeof forwardedFetch !== "function") throw new Error("expected forwarded fetch function");
    return { customFetch, forwardedFetch };
  }

  it("bypasses rate limiting for OAuth consumer requests", async () => {
    const { customFetch, forwardedFetch } = await getAuthFetchSetup(
      new Response("rate limited", { status: 429 }),
    );

    const oauthUrl = "https://thegarth.s3.amazonaws.com/consumer-data";
    const response = await forwardedFetch(oauthUrl);
    expect(response.status).toBe(429);
    expect(customFetch).toHaveBeenCalledWith(oauthUrl);
  });

  it("bypasses rate limiting for OAuth consumer URL objects", async () => {
    const { customFetch, forwardedFetch } = await getAuthFetchSetup();

    const oauthUrl = new URL("https://thegarth.s3.amazonaws.com/consumer-data");
    await forwardedFetch(oauthUrl);
    expect(customFetch).toHaveBeenCalledWith(oauthUrl);
  });

  it("bypasses rate limiting for OAuth consumer Request objects", async () => {
    // When resolveRequestUrl returns null for a Request object (mutant),
    // the Request goes through the rate-limited path which throws on 429.
    // The original code correctly resolves the URL and bypasses.
    const { customFetch, forwardedFetch } = await getAuthFetchSetup(
      new Response("rate limited", { status: 429 }),
    );

    const oauthRequest = new Request("https://thegarth.s3.amazonaws.com/consumer-data");
    const response = await forwardedFetch(oauthRequest);
    expect(response.status).toBe(429);
    expect(customFetch).toHaveBeenCalledWith(oauthRequest);
  });

  it("forwards init to baseFetchFn for OAuth consumer bypass", async () => {
    const { customFetch, forwardedFetch } = await getAuthFetchSetup();

    const oauthUrl = "https://thegarth.s3.amazonaws.com/consumer-data";
    const init = { method: "POST" };
    await forwardedFetch(oauthUrl, init);
    expect(customFetch).toHaveBeenCalledWith(oauthUrl, init);
  });

  it("forwards init through rate-limited path for non-OAuth requests", async () => {
    const { customFetch, forwardedFetch } = await getAuthFetchSetup();

    const nonOauthUrl = "https://connect.garmin.com/api/data";
    const init = { method: "POST" };
    await forwardedFetch(nonOauthUrl, init);
    expect(customFetch).toHaveBeenCalledWith(nonOauthUrl, {
      ...init,
      signal: expect.any(AbortSignal),
    });
  });

  it("handles invalid URLs passed to the forwarded fetch", async () => {
    const { forwardedFetch } = await getAuthFetchSetup();

    const result = await forwardedFetch("not-a-valid-url");
    expect(result).toBeInstanceOf(Response);
  });
});

// ============================================================
// Sync
// ============================================================

describe("GarminProvider.sync()", () => {
  let provider: GarminProvider;
  let db: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleMocks.inArrayValues.length = 0;
    publishedMetricStreamBatches.length = 0;
    delete process.env.CLICKHOUSE_URL;
    clickHouseMocks.createClickHouseClientFromEnv.mockClear();
    clickHouseMocks.query.mockReset();
    clickHouseMocks.query.mockResolvedValue({ json: async () => [] });
    clickHouseMocks.close.mockClear();
    providerActivityAbsenceMocks.markProviderActivityAbsent.mockClear();
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000001",
    });
    provider = new GarminProvider();
    db = createMockDb();

    // Default: valid internal tokens
    mocks.loadTokens.mockResolvedValue(fakeStoredTokens());

    // Default: fromTokens returns mock client
    mocks.fromTokens.mockResolvedValue(mocks.client);
    mocks.client.getTokens.mockReturnValue(fakeGarminTokens());

    // Default: all client methods return empty/no data (204 = expected "no content")
    const noDataError = new GarminApiError("No content available (204)", 204);
    mocks.client.getActivities.mockResolvedValue([]);
    mocks.client.getSleepData.mockRejectedValue(noDataError);
    mocks.client.getDailySummary.mockRejectedValue(noDataError);
    mocks.client.getHrvSummary.mockRejectedValue(noDataError);
    mocks.client.getTrainingStatus.mockRejectedValue(noDataError);
    mocks.client.getDailyStress.mockRejectedValue(noDataError);
    mocks.client.getDailyHeartRate.mockRejectedValue(noDataError);

    // Default: withSyncLog calls the function and returns result
    mocks.withSyncLog.mockImplementation(
      async (_db: unknown, _pid: string, _dt: string, fn: () => Promise<{ result: unknown }>) => {
        const res = await fn();
        return res.result;
      },
    );
  });

  it("passes provider-scoped rate-limit options to createProviderRateLimitFetch", async () => {
    const { createProviderRateLimitFetch } = await import("../lib/provider-rate-limit-fetch.ts");

    await syncProvider(provider, db, new Date());

    const mock = vi.mocked(createProviderRateLimitFetch);
    expect(mock).toHaveBeenCalledWith("garmin", expect.any(Function), expect.any(Object));

    const options = mock.mock.calls.find(([id]) => id === "garmin")?.[2];
    expect(options?.scope).toBeUndefined();
    expect(options?.userId).toBeUndefined();

    const createRateLimitError = options?.createRateLimitError;
    const error = createRateLimitError?.(new Response("too fast", { status: 429 }), "too fast");
    expect(error).toBeInstanceOf(GarminRateLimitError);
    if (error instanceof GarminRateLimitError) {
      expect(error.message).toBe("Rate limit exceeded (429): too fast");
      expect(error.retryAfterSeconds).toBeNull();
      expect(error.scope).toBe("provider");
    }
  });

  it("sync createRateLimitError handles null headers and missing get method", async () => {
    const { createProviderRateLimitFetch } = await import("../lib/provider-rate-limit-fetch.ts");

    await syncProvider(provider, db, new Date());

    const mock = vi.mocked(createProviderRateLimitFetch);
    const options = mock.mock.calls.find(([id]) => id === "garmin")?.[2];
    const createRateLimitError = options?.createRateLimitError;
    if (!createRateLimitError) throw new Error("expected createRateLimitError");

    const nullHeadersResponse = new Response("", { status: 429 });
    Object.defineProperty(nullHeadersResponse, "headers", {
      value: null,
      configurable: true,
    });
    const err1 = createRateLimitError(nullHeadersResponse, "body");
    expect(err1).toBeInstanceOf(GarminRateLimitError);
    if (err1 instanceof GarminRateLimitError) {
      expect(err1.retryAfterSeconds).toBeNull();
    }

    const noGetResponse = new Response("", { status: 429 });
    Object.defineProperty(noGetResponse, "headers", {
      value: {},
      configurable: true,
    });
    const err2 = createRateLimitError(noGetResponse, "");
    expect(err2).toBeInstanceOf(GarminRateLimitError);
    if (err2 instanceof GarminRateLimitError) {
      expect(err2.retryAfterSeconds).toBeNull();
    }
  });

  it("returns error when no tokens exist", async () => {
    mocks.loadTokens.mockResolvedValue(null);
    const result = await syncProvider(provider, db, new Date());

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
    expect(result.recordsSynced).toBe(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("returns error when tokens have invalid format", async () => {
    mocks.loadTokens.mockResolvedValue({
      accessToken: "plain-bearer-token",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 3600000),
      scopes: "regular-oauth",
    });
    const result = await syncProvider(provider, db, new Date());

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("not in the expected format");
    expect(result.recordsSynced).toBe(0);
  });

  it("returns error when GarminConnectClient.fromTokens fails", async () => {
    mocks.fromTokens.mockRejectedValue(new Error("auth failed"));
    const result = await syncProvider(provider, db, new Date());

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Connect API authentication failed");
    expect(result.recordsSynced).toBe(0);
  });

  it("refreshes expired tokens via GarminConnectClient.fromTokens", async () => {
    mocks.loadTokens.mockResolvedValue(fakeStoredTokens({ expiresAt: new Date("2020-01-01") }));
    const refreshedTokens = fakeGarminTokens();
    const refreshedClient = {
      getTokens: vi.fn().mockReturnValue(refreshedTokens),
    };
    mocks.fromTokens
      .mockResolvedValueOnce(refreshedClient) // resolveTokens refresh
      .mockResolvedValueOnce(mocks.client); // syncViaConnectApi

    mocks.client.getTokens.mockReturnValue(refreshedTokens);
    mocks.client.getActivities.mockResolvedValue([]);

    const result = await syncProvider(provider, db, new Date());

    expect(mocks.saveTokens).toHaveBeenCalled();
    expect(result.provider).toBe("garmin");
  });

  it("returns error when token refresh yields no tokens", async () => {
    mocks.loadTokens.mockResolvedValue(fakeStoredTokens({ expiresAt: new Date("2020-01-01") }));
    mocks.fromTokens.mockResolvedValueOnce({
      getTokens: vi.fn().mockReturnValue(null),
    });

    const result = await syncProvider(provider, db, new Date());

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Failed to refresh Garmin Connect tokens");
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("skips token refresh when stored tokens are still valid", async () => {
    const { logger } = await import("../logger.ts");

    await syncProvider(provider, db, new Date());

    expect(logger.info).not.toHaveBeenCalledWith(
      "[garmin] Internal API token expired, refreshing via OAuth1 exchange...",
    );
  });

  it("rethrows Garmin rate limit errors during token resolution", async () => {
    const rateLimitError = new GarminRateLimitError("Rate limit exceeded (429): limited");
    mocks.loadTokens.mockRejectedValue(rateLimitError);

    await expect(syncProvider(provider, db, new Date())).rejects.toBe(rateLimitError);
  });

  it("rethrows retryable infrastructure errors during token resolution", async () => {
    const infraError = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    mocks.loadTokens.mockRejectedValue(infraError);

    await expect(syncProvider(provider, db, new Date())).rejects.toBe(infraError);
  });

  it("throws when sync is invoked without a scoped user id", async () => {
    await expect(syncProvider(provider, db, new Date(), { userId: "" })).rejects.toThrow(
      "A user ID is required for this operation",
    );
  });

  it("syncs activities with detail streams", async () => {
    const rawActivity = { activityId: 123, deviceName: "Forerunner 955" };
    mocks.client.getActivities.mockResolvedValue([rawActivity]);

    mocks.parseConnectActivity.mockReturnValue({
      externalId: "123",
      activityType: "running",
      name: "Morning Run",
      startedAt: new Date("2026-03-01T10:00:00Z"),
      endedAt: new Date("2026-03-01T11:00:00Z"),
      raw: rawActivity,
    });

    mocks.client.getActivityDetail.mockResolvedValue({});
    mocks.parseActivityDetail.mockReturnValue({
      samples: [
        {
          directTimestamp: 1709286000000,
          directHeartRate: 150,
          directPower: 200,
          directRunCadence: 85,
          directBikeCadence: null,
          directSpeed: 3.5,
          directElevation: 100,
          directLatitude: 37.7749,
          directLongitude: -122.4194,
          directAirTemperature: 18,
        },
        {
          directTimestamp: null, // should be skipped
          directHeartRate: 155,
          directPower: null,
          directRunCadence: null,
          directBikeCadence: null,
          directSpeed: null,
          directElevation: null,
          directLatitude: null,
          directLongitude: null,
          directAirTemperature: null,
        },
        {
          directTimestamp: 1709286002000,
          directHeartRate: null,
          directPower: null,
          directRunCadence: null,
          directBikeCadence: 90,
          directSpeed: null,
          directElevation: null,
          directLatitude: null,
          directLongitude: null,
          directAirTemperature: null,
        },
      ],
    });

    const result = await syncProvider(provider, db, new Date("2026-02-01T00:00:00Z"));

    expect(mocks.parseConnectActivity).toHaveBeenCalledWith(rawActivity);
    expect(mocks.client.getActivityDetail).toHaveBeenCalledWith(123);
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);

    const sensorRows = publishedMetricStreamBatches
      .flat()
      .filter((row) => row?.providerId === "garmin" && typeof row?.channel === "string");

    expect(sensorRows).toHaveLength(8);
    expect(sensorRows.every((row) => row?.channel === "location" || row?.scalar != null)).toBe(
      true,
    );
    expect(sensorRows.length).toBeGreaterThan(0);
    expect(sensorRows).not.toContainEqual(expect.objectContaining({ channel: "lat" }));
    expect(sensorRows).not.toContainEqual(expect.objectContaining({ channel: "lng" }));
    expect(sensorRows).toContainEqual(
      expect.objectContaining({ channel: "heart_rate", scalar: 150 }),
    );
    expect(sensorRows).toContainEqual(expect.objectContaining({ channel: "power", scalar: 200 }));
    expect(sensorRows).toContainEqual(expect.objectContaining({ channel: "cadence", scalar: 85 }));
    expect(sensorRows).toContainEqual(expect.objectContaining({ channel: "speed", scalar: 3.5 }));
    expect(sensorRows).toContainEqual(
      expect.objectContaining({ channel: "altitude", scalar: 100 }),
    );
    expect(sensorRows).toContainEqual(
      expect.objectContaining({
        channel: "location",
        point: "SRID=4326;POINT(-122.4194 37.7749)",
      }),
    );
    expect(sensorRows).toContainEqual(
      expect.objectContaining({ channel: "temperature", scalar: 18 }),
    );
    expect(sensorRows).toContainEqual(expect.objectContaining({ channel: "cadence", scalar: 90 }));
  });

  it("skips activity detail fetch for activities already stored in the database", async () => {
    const rawActivity = { activityId: 123, deviceName: "Forerunner 955" };
    mocks.client.getActivities.mockResolvedValue([rawActivity]);
    mocks.parseConnectActivity.mockReturnValue({
      externalId: "123",
      activityType: "running",
      name: "Morning Run",
      startedAt: new Date("2026-03-01T10:00:00Z"),
      endedAt: new Date("2026-03-01T11:00:00Z"),
      raw: rawActivity,
    });

    db.where.mockReturnValue(
      Object.assign(Promise.resolve([{ externalId: "123" }]), {
        limit: vi.fn().mockResolvedValue([{ externalId: "123" }]),
      }),
    );

    const result = await syncProvider(provider, db, new Date("2026-02-01T00:00:00Z"));

    expect(mocks.client.getActivityDetail).not.toHaveBeenCalled();
    expect(result.recordsSynced).toBe(1);
  });

  it("looks up existing activities using external ids from the activity page", async () => {
    const rawActivity = { activityId: 123, deviceName: "Forerunner 955" };
    mocks.client.getActivities.mockResolvedValue([rawActivity]);
    mocks.parseConnectActivity.mockReturnValue({
      externalId: "123",
      activityType: "running",
      name: "Morning Run",
      startedAt: new Date("2026-03-01T10:00:00Z"),
      endedAt: new Date("2026-03-01T11:00:00Z"),
      raw: rawActivity,
    });

    await syncProvider(provider, db, new Date("2026-02-01T00:00:00Z"));

    expect(drizzleMocks.inArrayValues).toContainEqual(["123"]);
  });

  it("syncs detail streams without activity id when upsert returns no row", async () => {
    providerActivityAbsenceMocks.upsertProviderActivity.mockResolvedValue(undefined);

    const rawActivity = { activityId: 123, deviceName: "Forerunner 955" };
    mocks.client.getActivities.mockResolvedValue([rawActivity]);

    mocks.parseConnectActivity.mockReturnValue({
      externalId: "123",
      activityType: "running",
      name: "Morning Run",
      startedAt: new Date("2026-03-01T10:00:00Z"),
      endedAt: new Date("2026-03-01T11:00:00Z"),
      raw: rawActivity,
    });

    mocks.client.getActivityDetail.mockResolvedValue({});
    mocks.parseActivityDetail.mockReturnValue({
      samples: [
        {
          directTimestamp: 1709286000000,
          directHeartRate: 150,
          directPower: null,
          directRunCadence: 85,
          directBikeCadence: null,
          directSpeed: null,
          directElevation: null,
          directLatitude: null,
          directLongitude: null,
          directAirTemperature: null,
        },
      ],
    });

    const result = await syncProvider(provider, db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);

    const sensorRows = publishedMetricStreamBatches
      .flat()
      .filter((row) => row?.providerId === "garmin" && typeof row?.channel === "string");

    expect(sensorRows.length).toBeGreaterThan(0);
    expect(sensorRows.every((row) => row?.activityId === undefined)).toBe(true);
  });

  it("fetches activity detail when startedAt equals the sync window start", async () => {
    const since = new Date("2026-03-01T00:00:00.000Z");
    const until = new Date("2026-03-31T23:59:59.999Z");
    const rawActivity = { activityId: 123, deviceName: "Forerunner 955" };
    mocks.client.getActivities.mockResolvedValue([rawActivity]);
    mocks.parseConnectActivity.mockReturnValue({
      externalId: "123",
      activityType: "running",
      name: "Window Start Run",
      startedAt: since,
      endedAt: new Date("2026-03-01T01:00:00.000Z"),
      raw: rawActivity,
    });
    mocks.client.getActivityDetail.mockResolvedValue({});
    mocks.parseActivityDetail.mockReturnValue({ samples: [] });

    await syncProvider(provider, db, since, { until });

    expect(mocks.client.getActivityDetail).toHaveBeenCalledWith(123);
  });

  it("fetches activity detail when startedAt equals the sync window end", async () => {
    const since = new Date("2026-03-01T00:00:00.000Z");
    const until = new Date("2026-03-31T23:59:59.999Z");
    const rawActivity = { activityId: 456, deviceName: "Forerunner 955" };
    mocks.client.getActivities.mockResolvedValue([rawActivity]);
    mocks.parseConnectActivity.mockReturnValue({
      externalId: "456",
      activityType: "running",
      name: "Window End Run",
      startedAt: until,
      endedAt: new Date("2026-03-31T23:59:59.999Z"),
      raw: rawActivity,
    });
    mocks.client.getActivityDetail.mockResolvedValue({});
    mocks.parseActivityDetail.mockReturnValue({ samples: [] });

    await syncProvider(provider, db, since, { until });

    expect(mocks.client.getActivityDetail).toHaveBeenCalledWith(456);
  });

  it("skips activity detail when startedAt is before the sync window", async () => {
    const since = new Date("2026-03-01T00:00:00.000Z");
    const until = new Date("2026-03-31T23:59:59.999Z");
    const rawActivity = { activityId: 789, deviceName: "Forerunner 955" };
    mocks.client.getActivities.mockResolvedValue([rawActivity]);
    mocks.parseConnectActivity.mockReturnValue({
      externalId: "789",
      activityType: "running",
      name: "Too Early Run",
      startedAt: new Date("2026-02-01T00:00:00.000Z"),
      endedAt: new Date("2026-02-01T01:00:00.000Z"),
      raw: rawActivity,
    });

    await syncProvider(provider, db, since, { until });

    expect(mocks.client.getActivityDetail).not.toHaveBeenCalled();
  });

  it("skips activity detail when startedAt is after the sync window", async () => {
    const since = new Date("2026-03-01T00:00:00.000Z");
    const until = new Date("2026-03-31T23:59:59.999Z");
    const rawActivity = { activityId: 321, deviceName: "Forerunner 955" };
    mocks.client.getActivities.mockResolvedValue([rawActivity]);
    mocks.parseConnectActivity.mockReturnValue({
      externalId: "321",
      activityType: "running",
      name: "Too Late Run",
      startedAt: new Date("2026-04-01T00:00:00.000Z"),
      endedAt: new Date("2026-04-01T01:00:00.000Z"),
      raw: rawActivity,
    });

    await syncProvider(provider, db, since, { until });

    expect(mocks.client.getActivityDetail).not.toHaveBeenCalled();
  });

  it("does not query existing activity ids when the activity page is empty", async () => {
    mocks.client.getActivities.mockResolvedValue([]);

    await syncProvider(provider, db, new Date("2026-02-01T00:00:00.000Z"), {
      until: new Date("2026-03-31T23:59:59.999Z"),
    });

    expect(db.select).not.toHaveBeenCalledWith(
      expect.objectContaining({ externalId: expect.anything() }),
    );
  });

  it("reconciles provider absence using since when the activity page is partial", async () => {
    const since = new Date("2026-01-01T00:00:00Z");
    const rawActivity = { activityId: 123, deviceName: "Forerunner 955" };
    mocks.client.getActivities.mockResolvedValue([rawActivity]);
    mocks.parseConnectActivity.mockReturnValue({
      externalId: "123",
      activityType: "running",
      name: "Morning Run",
      startedAt: new Date("2026-03-01T10:00:00Z"),
      endedAt: new Date("2026-03-01T11:00:00Z"),
      raw: rawActivity,
    });
    mocks.client.getActivityDetail.mockResolvedValue({});
    mocks.parseActivityDetail.mockReturnValue({ samples: [] });

    await syncProvider(provider, db, since);

    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        providerId: "garmin",
        userId: "00000000-0000-0000-0000-000000000001",
        windowStart: since,
        presentExternalIds: new Set(["123"]),
      }),
    );
  });

  it("paginates activity fetches until a partial page and then reconciles", async () => {
    const since = new Date("2026-01-01T00:00:00Z");
    const fullPage = Array.from({ length: 50 }, (_, index) => ({ activityId: index + 1 }));
    const partialPage = [{ activityId: 51 }];

    mocks.client.getActivities.mockResolvedValueOnce(fullPage).mockResolvedValueOnce(partialPage);
    mocks.parseConnectActivity.mockImplementation((raw: { activityId: number }) => ({
      externalId: String(raw.activityId),
      activityType: "running",
      name: `Run ${raw.activityId}`,
      startedAt: new Date("2026-03-01T10:00:00Z"),
      endedAt: new Date("2026-03-01T11:00:00Z"),
      raw,
    }));
    mocks.client.getActivityDetail.mockResolvedValue({});
    mocks.parseActivityDetail.mockReturnValue({ samples: [] });

    await syncProvider(provider, db, since);

    expect(mocks.client.getActivities).toHaveBeenCalledTimes(2);
    expect(mocks.client.getActivities).toHaveBeenNthCalledWith(1, 0, 50);
    expect(mocks.client.getActivities).toHaveBeenNthCalledWith(2, 50, 50);
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        providerId: "garmin",
        userId: "00000000-0000-0000-0000-000000000001",
        windowStart: since,
        presentExternalIds: new Set([
          ...fullPage.map((activity) => String(activity.activityId)),
          "51",
        ]),
      }),
    );
  });

  it("records degraded pagination and skips reconciliation when the activity list keeps returning full pages", async () => {
    const since = new Date("2026-01-01T00:00:00Z");
    const fullPage = Array.from({ length: 50 }, (_, index) => ({ activityId: index + 1 }));
    mocks.client.getActivities.mockResolvedValue(fullPage);
    mocks.parseConnectActivity.mockImplementation((raw: { activityId: number }) => ({
      externalId: String(raw.activityId),
      activityType: "running",
      name: `Run ${raw.activityId}`,
      startedAt: new Date("2026-03-01T10:00:00Z"),
      endedAt: new Date("2026-03-01T11:00:00Z"),
      raw,
    }));

    const checkpointStore = {
      load: vi.fn().mockResolvedValue({
        ...createGarminSyncCheckpoint([{ type: "activities_list", offset: 4950 }]),
        stepIndex: 0,
      }),
      save: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const result = await syncProvider(provider, db, since, { checkpoint: checkpointStore });

    expect(result.degradations).toEqual([
      {
        kind: "pagination_stalled",
        providerId: "garmin",
        stepName: "activities_list",
        message: "Garmin activity pagination exceeded the maximum offset guard",
        context: { offset: 4950, pageSize: 50 },
      },
    ]);
    expect(mocks.client.getActivities).toHaveBeenCalledExactlyOnceWith(4950, 50);
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).not.toHaveBeenCalled();
    expect(
      checkpointStore.save.mock.calls.some(([checkpoint]) =>
        checkpoint.steps.some((step: GarminSyncStep) => step.type === "activity_reconcile"),
      ),
    ).toBe(false);
  });

  it("syncs sleep data", async () => {
    mocks.client.getSleepData.mockResolvedValue({ sleepData: true });
    mocks.parseConnectSleep.mockReturnValue({
      externalId: "2026-03-01",
      startedAt: new Date("2026-03-01T00:00:00Z"),
      endedAt: new Date("2026-03-01T08:00:00Z"),
      durationMinutes: 480,
      deepMinutes: 90,
      lightMinutes: 210,
      remMinutes: 120,
      awakeMinutes: 60,
    });

    const result = await syncProvider(provider, db, new Date());

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify sleep values were passed to DB
    const sleepCall = db.values.mock.calls.find((call) => call[0]?.durationMinutes === 480);
    if (!sleepCall) throw new Error("expected sleep insert");
    expect(sleepCall[0].providerId).toBe("garmin");
    expect(sleepCall[0].deepMinutes).toBe(90);
    expect(sleepCall[0].lightMinutes).toBe(210);
    expect(sleepCall[0].remMinutes).toBe(120);
    expect(sleepCall[0].awakeMinutes).toBe(60);
  });

  it("inserts sleep stages when parseConnectSleepStages returns data", async () => {
    mocks.client.getSleepData.mockResolvedValue({ sleepData: true });
    mocks.parseConnectSleep.mockReturnValue({
      externalId: "2026-03-01",
      startedAt: new Date("2026-03-01T00:00:00Z"),
      endedAt: new Date("2026-03-01T08:00:00Z"),
      durationMinutes: 480,
      deepMinutes: 90,
      lightMinutes: 210,
      remMinutes: 120,
      awakeMinutes: 60,
    });

    const stages = [
      {
        stage: "deep",
        startedAt: new Date("2026-03-01T01:00:00Z"),
        endedAt: new Date("2026-03-01T02:30:00Z"),
      },
      {
        stage: "light",
        startedAt: new Date("2026-03-01T02:30:00Z"),
        endedAt: new Date("2026-03-01T04:00:00Z"),
      },
      {
        stage: "rem",
        startedAt: new Date("2026-03-01T04:00:00Z"),
        endedAt: new Date("2026-03-01T05:00:00Z"),
      },
    ];
    mocks.parseConnectSleepStages.mockReturnValue(stages);

    const result = await syncProvider(provider, db, new Date());

    expect(result.recordsSynced).toBe(1);

    // Verify sleep stages were inserted
    // db.delete should have been called for existing stages, then db.insert for new ones
    const stageInsertCall = db.values.mock.calls.find(
      (call) => Array.isArray(call[0]) && call[0][0]?.stage === "deep",
    );
    expect(stageInsertCall).toBeDefined();
    expect(stageInsertCall?.[0]).toHaveLength(3);
    expect(stageInsertCall?.[0][0].sessionId).toBe("mock-session-id");
    expect(stageInsertCall?.[0][0].stage).toBe("deep");
    expect(stageInsertCall?.[0][1].stage).toBe("light");
    expect(stageInsertCall?.[0][2].stage).toBe("rem");
    expect(stageInsertCall?.[0][0].startedAt).toEqual(new Date("2026-03-01T01:00:00Z"));
    expect(stageInsertCall?.[0][0].endedAt).toEqual(new Date("2026-03-01T02:30:00Z"));
  });

  it("does not insert stages when parseConnectSleepStages returns empty array", async () => {
    mocks.client.getSleepData.mockResolvedValue({ sleepData: true });
    mocks.parseConnectSleep.mockReturnValue({
      externalId: "2026-03-01",
      startedAt: new Date("2026-03-01T00:00:00Z"),
      endedAt: new Date("2026-03-01T08:00:00Z"),
      durationMinutes: 480,
      deepMinutes: 90,
      lightMinutes: 210,
      remMinutes: 120,
      awakeMinutes: 60,
    });
    mocks.parseConnectSleepStages.mockReturnValue([]);

    // Track delete calls before sync to detect stage deletion
    const deleteCallsBefore = db.delete.mock.calls.length;

    const result = await syncProvider(provider, db, new Date());

    expect(result.recordsSynced).toBe(1);

    // Should NOT have inserted any stage arrays
    const stageInsertCall = db.values.mock.calls.find(
      (call) => Array.isArray(call[0]) && call[0][0]?.stage,
    );
    expect(stageInsertCall).toBeUndefined();

    // Should NOT have called values with an empty array (stage guard: length > 0)
    const emptyArrayInsert = db.values.mock.calls.find(
      (call) => Array.isArray(call[0]) && call[0].length === 0,
    );
    expect(emptyArrayInsert).toBeUndefined();

    // No additional delete calls should have been made for stages
    // (only the sync cursor / provider deletes happen, not stage deletion)
    expect(db.delete.mock.calls.length).toBe(deleteCallsBefore);
  });

  it("skips null sleep data from parseConnectSleep", async () => {
    mocks.client.getSleepData.mockResolvedValue({});
    mocks.parseConnectSleep.mockReturnValue(null);

    const result = await syncProvider(provider, db, new Date());
    expect(result.recordsSynced).toBe(0);
  });

  it("syncs daily metrics with HRV and training status", async () => {
    mocks.client.getDailySummary.mockResolvedValue({ privacyProtected: false });
    mocks.parseConnectDailySummary.mockReturnValue({
      date: "2026-03-01",
      steps: 10000,
      distanceKm: 8.5,
      restingHr: 55,
      spo2Avg: 97,
      respiratoryRateAvg: 15,
      flightsClimbed: 12,
      exerciseMinutes: 45,
    });

    mocks.client.getHrvSummary.mockResolvedValue({});
    mocks.parseHrvSummary.mockReturnValue({ lastNightAvg: 45, lastNight: 42 });
    db.where.mockImplementation(() =>
      Object.assign(Promise.resolve([]), {
        limit: vi.fn().mockImplementation(() => {
          const projection = db.select.mock.calls.at(-1)?.[0];
          if (projection && typeof projection === "object" && "id" in projection) {
            return Promise.resolve([{ id: "daily-metrics-id" }]);
          }
          return Promise.resolve([]);
        }),
      }),
    );

    const result = await syncProvider(provider, db, new Date());

    expect(result.recordsSynced).toBe(2);
    expect(mocks.client.getHrvSummary).toHaveBeenCalled();

    // Verify daily metrics insert values
    const dailyCall = db.values.mock.calls.find((call) => call[0]?.steps === 10000);
    if (!dailyCall) throw new Error("expected daily metrics insert");
    expect(dailyCall[0].providerId).toBe("garmin");
    expect(dailyCall[0].distanceKm).toBe(8.5);
    expect(Object.hasOwn(dailyCall[0], "restingHr")).toBe(false);
    expect(dailyCall[0].spo2Avg).toBe(97);
    expect(dailyCall[0].respiratoryRateAvg).toBe(15);
    expect(dailyCall[0].flightsClimbed).toBe(12);
    expect(dailyCall[0].exerciseMinutes).toBe(45);
    expect(Object.hasOwn(dailyCall[0], "hrv")).toBe(false);
    expect(Object.hasOwn(dailyCall[0], "vo2max")).toBe(false);
    expect(mocks.client.getTrainingStatus).not.toHaveBeenCalled();
    const hrvConflictCall = db.onConflictDoUpdate.mock.calls.find(
      (call) => call[0]?.set?.hrv === 45,
    );
    expect(hrvConflictCall).toBeDefined();

    // Verify the onConflictDoUpdate set clause has the same values
    const conflictCall = db.onConflictDoUpdate.mock.calls.find(
      (call) => call[0]?.set?.steps === 10000,
    );
    expect(conflictCall).toBeDefined();
    expect(conflictCall?.[0].set.distanceKm).toBe(8.5);
    expect(Object.hasOwn(conflictCall?.[0].set ?? {}, "restingHr")).toBe(false);
    expect(conflictCall?.[0].set.spo2Avg).toBe(97);
    expect(conflictCall?.[0].set.respiratoryRateAvg).toBe(15);
    expect(conflictCall?.[0].set.flightsClimbed).toBe(12);
    expect(conflictCall?.[0].set.exerciseMinutes).toBe(45);
    expect(Object.hasOwn(conflictCall?.[0].set ?? {}, "hrv")).toBe(false);
    expect(Object.hasOwn(conflictCall?.[0].set ?? {}, "vo2max")).toBe(false);
    // Verify target includes the expected conflict columns
    expect(conflictCall?.[0].target).toBeDefined();
    expect(conflictCall?.[0].target.length).toBe(4);
  });

  it("skips privacy-protected daily summaries", async () => {
    mocks.client.getDailySummary.mockResolvedValue({ privacyProtected: true });

    const result = await syncProvider(provider, db, new Date());

    expect(mocks.parseConnectDailySummary).not.toHaveBeenCalled();
    expect(result.recordsSynced).toBe(0);
  });

  it("handles HRV fetch failures gracefully", async () => {
    mocks.client.getDailySummary.mockResolvedValue({ privacyProtected: false });
    mocks.parseConnectDailySummary.mockReturnValue({
      date: "2026-03-01",
      steps: 5000,
      distanceKm: 4,
    });
    mocks.client.getHrvSummary.mockRejectedValue(
      new GarminApiError("No content available (204)", 204),
    );
    const result = await syncProvider(provider, db, new Date());

    expect(result.recordsSynced).toBe(1);

    const dailyCall = db.values.mock.calls.find((call) => call[0]?.steps === 5000);
    if (!dailyCall) throw new Error("expected daily metrics insert");
    expect(dailyCall[0].hrv).toBeUndefined();
    expect(Object.hasOwn(dailyCall[0], "vo2max")).toBe(false);
  });

  it("syncs stress time-series", async () => {
    mocks.client.getDailyStress.mockResolvedValue({});
    mocks.parseStressTimeSeries.mockReturnValue({
      samples: [
        { timestamp: new Date("2026-03-01T12:00:00Z"), stressLevel: 35 },
        { timestamp: new Date("2026-03-01T12:05:00Z"), stressLevel: 42 },
      ],
    });

    const result = await syncProvider(provider, db, new Date());

    expect(result.recordsSynced).toBe(2);

    const stressCall = publishedMetricStreamBatches
      .flat()
      .find((row) => row?.channel === "stress" && row?.scalar === 35);
    if (!stressCall) throw new Error("expected stress insert");
    expect(stressCall.providerId).toBe("garmin");
  });

  it("syncs heart rate time-series", async () => {
    mocks.client.getDailyHeartRate.mockResolvedValue({});
    mocks.parseHeartRateTimeSeries.mockReturnValue({
      samples: [
        { timestamp: new Date("2026-03-01T12:00:00Z"), heartRate: 72 },
        { timestamp: new Date("2026-03-01T12:05:00Z"), heartRate: 75 },
      ],
    });

    const result = await syncProvider(provider, db, new Date());

    expect(result.recordsSynced).toBe(2);

    const hrCall = publishedMetricStreamBatches
      .flat()
      .find((row) => row?.channel === "heart_rate" && row?.scalar === 72);
    if (!hrCall) throw new Error("expected heart rate insert");
    expect(hrCall.providerId).toBe("garmin");
  });

  it("syncs all data types together and sums record counts", async () => {
    const syncSince = new Date("2026-03-01T00:00:00Z");
    const syncUntil = new Date("2026-03-01T23:59:59Z");
    const activityStartedAt = new Date("2026-03-01T12:00:00Z");
    const activityEndedAt = new Date("2026-03-01T13:00:00Z");

    mocks.client.getActivities.mockResolvedValue([{ activityId: 1 }]);
    mocks.parseConnectActivity.mockReturnValue({
      externalId: "1",
      activityType: "running",
      name: "Run",
      startedAt: activityStartedAt,
      endedAt: activityEndedAt,
      raw: {},
    });
    mocks.client.getActivityDetail.mockRejectedValue(
      new GarminApiError("No content available (204)", 204),
    );

    mocks.client.getSleepData.mockResolvedValue({});
    mocks.parseConnectSleep.mockReturnValue({
      externalId: "today",
      startedAt: activityStartedAt,
      endedAt: activityEndedAt,
      durationMinutes: 480,
      deepMinutes: 90,
      lightMinutes: 210,
      remMinutes: 120,
      awakeMinutes: 60,
    });

    mocks.client.getDailySummary.mockResolvedValue({ privacyProtected: false });
    mocks.parseConnectDailySummary.mockReturnValue({
      date: "today",
      steps: 10000,
      distanceKm: 8,
    });
    mocks.client.getHrvSummary.mockRejectedValue(
      new GarminApiError("No content available (204)", 204),
    );
    mocks.client.getTrainingStatus.mockRejectedValue(
      new GarminApiError("No content available (204)", 204),
    );

    mocks.client.getDailyStress.mockResolvedValue({});
    mocks.parseStressTimeSeries.mockReturnValue({
      samples: [{ timestamp: new Date("2026-03-01T14:00:00Z"), stressLevel: 30 }],
    });

    mocks.client.getDailyHeartRate.mockResolvedValue({});
    mocks.parseHeartRateTimeSeries.mockReturnValue({
      samples: [{ timestamp: new Date("2026-03-01T14:05:00Z"), heartRate: 65 }],
    });

    const result = await syncProvider(provider, db, syncSince, { until: syncUntil });

    // 1 sleep + 1 daily + 1 stress + 1 heart rate = 4
    expect(result.recordsSynced).toBe(4);
    expect(result.errors).toHaveLength(0);
    expect(result.provider).toBe("garmin");
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("handles individual sync method failures without failing the whole sync", async () => {
    mocks.client.getActivities.mockRejectedValue(new Error("activities sync crashed"));

    mocks.client.getSleepData.mockResolvedValue({});
    mocks.parseConnectSleep.mockReturnValue({
      externalId: "today",
      startedAt: new Date(),
      endedAt: new Date(),
      durationMinutes: 480,
      deepMinutes: 90,
      lightMinutes: 210,
      remMinutes: 120,
      awakeMinutes: 60,
    });

    const result = await syncProvider(provider, db, new Date());

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Activities sync failed");
    expect(result.recordsSynced).toBe(1);
  });

  it("stops the provider sync immediately when Garmin rate limits a phase", async () => {
    const rateLimitError = new GarminRateLimitError("Rate limit exceeded (429): limited");
    mocks.client.getSleepData.mockRejectedValue(rateLimitError);

    await expect(syncProvider(provider, db, new Date())).rejects.toBe(rateLimitError);

    expect(mocks.client.getDailySummary).not.toHaveBeenCalled();
    expect(mocks.client.getDailyStress).not.toHaveBeenCalled();
    expect(mocks.client.getDailyHeartRate).not.toHaveBeenCalled();
  });

  it("calls ensureProvider with correct args", async () => {
    await syncProvider(provider, db, new Date());

    expect(mocks.ensureProvider).toHaveBeenCalledWith(db, "garmin", "Garmin Connect");
  });

  it("saves refreshed tokens from client after sync", async () => {
    const refreshedTokens = fakeGarminTokens();
    mocks.client.getTokens.mockReturnValue(refreshedTokens);

    await syncProvider(provider, db, new Date());

    expect(mocks.saveTokens).toHaveBeenCalledWith(
      db,
      "garmin",
      expect.objectContaining({
        accessToken: JSON.stringify(refreshedTokens),
        scopes: INTERNAL_SCOPE_MARKER,
      }),
      expect.any(String),
    );
  });

  it("uses sync cursor when available", async () => {
    db.limit.mockResolvedValueOnce([{ value: { cursor: "2026-02-15T00:00:00.000Z" } }]);
    const until = new Date("2026-02-15T00:00:00.000Z");

    await syncProvider(provider, db, new Date("2026-01-01T00:00:00.000Z"), { until });

    expect(mocks.withSyncLog).toHaveBeenCalledTimes(4);
  });

  it("ignores sync cursors stored as non-string values", async () => {
    db.limit.mockResolvedValueOnce([{ value: { cursor: 12345 } }]);
    const until = new Date("2026-02-15T00:00:00.000Z");

    await syncProvider(provider, db, new Date("2026-02-15T00:00:00.000Z"), { until });

    expect(mocks.withSyncLog).toHaveBeenCalledTimes(4);
  });

  it("ignores sync cursor settings with null or non-object values", async () => {
    db.limit.mockResolvedValueOnce([{ value: null }]);
    const until = new Date("2026-02-15T00:00:00.000Z");

    await syncProvider(provider, db, new Date("2026-02-15T00:00:00.000Z"), { until });

    expect(mocks.withSyncLog).toHaveBeenCalledTimes(4);
  });

  it("ignores sync cursors with invalid date strings", async () => {
    db.limit.mockResolvedValueOnce([{ value: { cursor: "not-a-date" } }]);
    const until = new Date("2026-02-15T00:00:00.000Z");

    await syncProvider(provider, db, new Date("2026-02-15T00:00:00.000Z"), { until });

    expect(mocks.withSyncLog).toHaveBeenCalledTimes(4);
  });

  it("persists the sync cursor after a completed sync", async () => {
    const until = new Date("2026-03-01T00:00:00.000Z");

    await syncProvider(provider, db, new Date("2026-02-01T00:00:00.000Z"), {
      until,
      checkpoint: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      },
    });

    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "garmin_sync_cursor",
        value: { cursor: until.toISOString() },
      }),
    );
    expect(db.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          value: { cursor: until.toISOString() },
        }),
      }),
    );
  });

  it("resumes from a saved checkpoint instead of restarting completed steps", async () => {
    const since = new Date("2026-04-26T00:00:00.000Z");
    const until = new Date("2026-04-27T00:00:00.000Z");
    const steps = await planAllGarminSteps(db, since, until);
    const stepIndex = steps.findIndex(
      (step) => step.type === "daily_summary" && step.date === "2026-04-27",
    );
    if (stepIndex === -1) throw new Error("expected daily_summary step");
    const checkpointStore = {
      load: vi.fn().mockResolvedValue({
        ...createGarminSyncCheckpoint(steps),
        stepIndex,
      }),
      save: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    await syncProvider(provider, db, since, {
      until,
      userId: "00000000-0000-0000-0000-000000000001",
      checkpoint: checkpointStore,
    });

    const syncedDataTypes = mocks.withSyncLog.mock.calls.map((call) => call[2]);
    expect(syncedDataTypes).toEqual(["daily_metrics", "stress", "heart_rate"]);
    expect(mocks.client.getSleepData).not.toHaveBeenCalled();
    expect(mocks.client.getDailySummary).toHaveBeenCalledWith("2026-04-27");
    expect(checkpointStore.clear).toHaveBeenCalledOnce();
  });

  it("resumes an in-progress step chain and advances the step index", async () => {
    const since = new Date("2026-04-25T00:00:00.000Z");
    const until = new Date("2026-04-27T00:00:00.000Z");
    const steps = await planAllGarminSteps(db, since, until);
    const stepIndex = steps.findIndex(
      (step) => step.type === "sleep" && step.date === "2026-04-27",
    );
    if (stepIndex === -1) throw new Error("expected sleep step");
    const checkpointStore = {
      load: vi.fn().mockResolvedValue({
        ...createGarminSyncCheckpoint(steps),
        stepIndex,
      }),
      save: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    await syncProvider(provider, db, since, {
      until,
      userId: "00000000-0000-0000-0000-000000000001",
      checkpoint: checkpointStore,
    });

    expect(mocks.client.getActivities).not.toHaveBeenCalled();
    expect(mocks.client.getSleepData).not.toHaveBeenCalledWith("2026-04-25");
    expect(mocks.client.getSleepData).not.toHaveBeenCalledWith("2026-04-26");
    expect(mocks.client.getSleepData).toHaveBeenCalledWith("2026-04-27");
    expect(checkpointStore.save).toHaveBeenCalled();
    expect(checkpointStore.clear).toHaveBeenCalledTimes(1);

    const savedCheckpoints = checkpointStore.save.mock.calls.map(([checkpoint]) => checkpoint);
    expect(savedCheckpoints.at(-1)).toMatchObject({ phase: "done" });
  });

  it("does not call captureException for 204 (no data) errors", async () => {
    const { captureException } = await import("@sentry/node");

    await syncProvider(provider, db, new Date());

    expect(captureException).not.toHaveBeenCalled();
  });

  it("calls captureException for non-204 errors (once per operation)", async () => {
    const { captureException } = await import("@sentry/node");

    // Sleep will fail with a real error on every date
    mocks.client.getSleepData.mockRejectedValue(new Error("server error"));

    const result = await syncProvider(provider, db, new Date());

    // captureException should be called exactly once for the sleep operation
    // (rate-limited to first error per operation)
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { provider: "garmin", operation: "sleep" },
      }),
    );

    // The error should propagate to the sync result
    expect(
      result.errors.some((syncError: { message: string }) =>
        syncError.message.includes("Sleep sync failed"),
      ),
    ).toBe(true);
  });

  it("propagates per-date errors to sync result so withSyncLog records them", async () => {
    // Make daily summary fail with a real error
    mocks.client.getDailySummary.mockRejectedValue(new Error("API outage"));

    const result = await syncProvider(provider, db, new Date());

    expect(
      result.errors.some((syncError: { message: string }) =>
        syncError.message.includes("Daily metrics sync failed"),
      ),
    ).toBe(true);
  });

  it("enqueues a continuation after completing the activities list step", async () => {
    const checkpointStore = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const enqueueSyncContinuation = vi.fn(async () => undefined);

    const result = await syncProvider(provider, db, new Date(), {
      checkpoint: checkpointStore,
      enqueueSyncContinuation,
    });

    expect(result).toMatchObject({
      provider: "garmin",
      recordsSynced: 0,
      errors: [],
      continued: true,
    });
    expect(mocks.client.getActivities).toHaveBeenCalledOnce();
    expect(mocks.client.getSleepData).not.toHaveBeenCalled();
    expect(checkpointStore.clear).not.toHaveBeenCalled();
    expect(db.values).not.toHaveBeenCalledWith(
      expect.objectContaining({
        key: "garmin_sync_cursor",
      }),
    );
    expect(enqueueSyncContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "api",
        stepIndex: 1,
        steps: expect.arrayContaining([
          { type: "activities_list", offset: 0 },
          { type: "activity_reconcile" },
        ]),
      }),
    );
  });

  it("reports paginated activity list progress with offset", async () => {
    const progressMessages: string[] = [];
    const checkpointStore = {
      load: vi.fn().mockResolvedValue({
        ...createGarminSyncCheckpoint([
          { type: "activities_list", offset: 50 },
          { type: "activity_reconcile" },
        ]),
        stepIndex: 0,
      }),
      save: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    mocks.client.getActivities.mockResolvedValue([]);

    await syncProvider(provider, db, new Date(), {
      checkpoint: checkpointStore,
      enqueueSyncContinuation: vi.fn(async () => undefined),
      onProgress: (_percentage, message) => {
        progressMessages.push(message);
      },
    });

    expect(progressMessages).toContain("Activity list (offset 50)");
  });

  it("runs all steps in one job when no continuation hook is provided", async () => {
    const checkpointStore = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const result = await syncProvider(provider, db, new Date(), {
      checkpoint: checkpointStore,
    });

    expect(result.continued).toBe(false);
    expect(mocks.withSyncLog).toHaveBeenCalledTimes(4);
    expect(checkpointStore.clear).toHaveBeenCalledOnce();
  });

  it("resumes from checkpoint and enqueues the next step only", async () => {
    const since = new Date("2026-04-26T00:00:00.000Z");
    const until = new Date("2026-04-27T00:00:00.000Z");
    const steps = await planAllGarminSteps(db, since, until);
    const stepIndex = steps.findIndex(
      (step) => step.type === "daily_summary" && step.date === "2026-04-27",
    );
    if (stepIndex === -1) throw new Error("expected daily_summary step");
    const checkpointStore = {
      load: vi.fn().mockResolvedValue({
        ...createGarminSyncCheckpoint(steps),
        stepIndex,
      }),
      save: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const enqueueSyncContinuation = vi.fn(async () => undefined);

    const result = await syncProvider(provider, db, since, {
      until,
      userId: "00000000-0000-0000-0000-000000000001",
      checkpoint: checkpointStore,
      enqueueSyncContinuation,
    });

    expect(result.continued).toBe(true);
    expect(mocks.client.getSleepData).not.toHaveBeenCalled();
    expect(mocks.client.getDailySummary).toHaveBeenCalledWith("2026-04-27");
    expect(mocks.client.getDailyStress).not.toHaveBeenCalled();
    expect(enqueueSyncContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "api",
        stepIndex: stepIndex + 1,
      }),
    );
    expect(checkpointStore.clear).not.toHaveBeenCalled();
  });
});
