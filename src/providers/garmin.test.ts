import type { GarminTokens } from "garmin-connect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenSet } from "../auth/oauth.ts";
import {
  deserializeInternalTokens,
  eachDay,
  formatDate,
  GarminProvider,
  INTERNAL_SCOPE_MARKER,
  serializeInternalTokens,
} from "./garmin.ts";

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

vi.mock("garmin-connect", () => ({
  GarminConnectClient: {
    signIn: mocks.signIn,
    fromTokens: mocks.fromTokens,
  },
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

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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
  values: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
  onConflictDoNothing: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function createMockDb(): MockDb {
  const db: MockDb = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn(),
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    returning: vi.fn().mockResolvedValue([{ id: "mock-session-id" }]),
    delete: vi.fn(),
  };
  // Chain: select/from/where/insert/values all return the mock object itself
  db.select.mockReturnValue(db);
  db.from.mockReturnValue(db);
  db.where.mockReturnValue(db);
  db.insert.mockReturnValue(db);
  db.values.mockReturnValue(db);
  db.onConflictDoUpdate.mockReturnValue(db);
  db.delete.mockReturnValue(db);
  return db;
}

// Typed wrapper to call provider.sync() with a mock DB.
// The mock DB duck-types SyncDatabase at runtime but cannot satisfy the
// Drizzle branded type at compile time, so we widen via bind().
function syncProvider(provider: GarminProvider, db: MockDb, since: Date) {
  // Use Reflect.apply to call sync() with a mock DB that structurally
  // matches SyncDatabase at runtime but not at compile time
  return Reflect.apply(provider.sync, provider, [db, since]) satisfies Promise<{
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

  it("uses a dummy OAuth config (internal API only)", () => {
    const provider = new GarminProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("garmin-connect-internal");
    expect(setup.oauthConfig.authorizeUrl).toBe("");
    expect(setup.oauthConfig.tokenUrl).toBe("");
    expect(setup.oauthConfig.redirectUri).toBe("");
    expect(setup.oauthConfig.scopes).toEqual([]);
  });

  it("exchangeCode always rejects (credential-only)", async () => {
    const provider = new GarminProvider();
    const setup = provider.authSetup();
    await expect(setup.exchangeCode("some-code")).rejects.toThrow(
      "Garmin uses credential-based sign-in",
    );
  });

  it("automatedLogin calls GarminConnectClient.signIn with the provider's fetchFn", async () => {
    const customFetch: typeof globalThis.fetch = vi.fn();
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
      customFetch,
    );
    expect(result.accessToken).toBe(JSON.stringify(tokens));
    expect(result.scopes).toBe(INTERNAL_SCOPE_MARKER);
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
    provider = new GarminProvider();
    db = createMockDb();

    // Default: valid internal tokens
    mocks.loadTokens.mockResolvedValue(fakeStoredTokens());

    // Default: fromTokens returns mock client
    mocks.fromTokens.mockResolvedValue(mocks.client);
    mocks.client.getTokens.mockReturnValue(fakeGarminTokens());

    // Default: all client methods return empty/no data
    mocks.client.getActivities.mockResolvedValue([]);
    mocks.client.getSleepData.mockRejectedValue(new Error("no data"));
    mocks.client.getDailySummary.mockRejectedValue(new Error("no data"));
    mocks.client.getHrvSummary.mockRejectedValue(new Error("no data"));
    mocks.client.getTrainingStatus.mockRejectedValue(new Error("no data"));
    mocks.client.getDailyStress.mockRejectedValue(new Error("no data"));
    mocks.client.getDailyHeartRate.mockRejectedValue(new Error("no data"));

    // Default: withSyncLog calls the function and returns result
    mocks.withSyncLog.mockImplementation(
      async (_db: unknown, _pid: string, _dt: string, fn: () => Promise<{ result: unknown }>) => {
        const res = await fn();
        return res.result;
      },
    );
  });

  it("returns error when no tokens exist", async () => {
    mocks.loadTokens.mockResolvedValue(null);
    const result = await syncProvider(provider, db, new Date());

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
    expect(result.recordsSynced).toBe(0);
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

    const result = await syncProvider(provider, db, new Date());

    expect(mocks.parseConnectActivity).toHaveBeenCalledWith(rawActivity);
    expect(mocks.client.getActivityDetail).toHaveBeenCalledWith(123);
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify stream samples were inserted (2 valid, 1 null-timestamp skipped)
    expect(db.onConflictDoNothing.mock.calls.length).toBeGreaterThanOrEqual(2);
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
      activeEnergyKcal: 500,
      basalEnergyKcal: 1800,
      restingHr: 55,
      spo2Avg: 97,
      respiratoryRateAvg: 15,
      flightsClimbed: 12,
      exerciseMinutes: 45,
    });

    mocks.client.getHrvSummary.mockResolvedValue({});
    mocks.parseHrvSummary.mockReturnValue({ lastNightAvg: 45, lastNight: 42 });

    mocks.client.getTrainingStatus.mockResolvedValue({});
    mocks.parseTrainingStatus.mockReturnValue({ vo2MaxRunning: 55, vo2MaxCycling: 52 });

    const result = await syncProvider(provider, db, new Date());

    expect(result.recordsSynced).toBe(1);

    // Verify daily metrics insert values
    const dailyCall = db.values.mock.calls.find((call) => call[0]?.steps === 10000);
    if (!dailyCall) throw new Error("expected daily metrics insert");
    expect(dailyCall[0].providerId).toBe("garmin");
    expect(dailyCall[0].distanceKm).toBe(8.5);
    expect(dailyCall[0].activeEnergyKcal).toBe(500);
    expect(dailyCall[0].basalEnergyKcal).toBe(1800);
    expect(dailyCall[0].restingHr).toBe(55);
    expect(dailyCall[0].spo2Avg).toBe(97);
    expect(dailyCall[0].respiratoryRateAvg).toBe(15);
    expect(dailyCall[0].flightsClimbed).toBe(12);
    expect(dailyCall[0].exerciseMinutes).toBe(45);
    expect(dailyCall[0].hrv).toBe(45);
    expect(dailyCall[0].vo2max).toBe(55);
  });

  it("skips privacy-protected daily summaries", async () => {
    mocks.client.getDailySummary.mockResolvedValue({ privacyProtected: true });

    const result = await syncProvider(provider, db, new Date());

    expect(mocks.parseConnectDailySummary).not.toHaveBeenCalled();
    expect(result.recordsSynced).toBe(0);
  });

  it("handles HRV and training status fetch failures gracefully", async () => {
    mocks.client.getDailySummary.mockResolvedValue({ privacyProtected: false });
    mocks.parseConnectDailySummary.mockReturnValue({
      date: "2026-03-01",
      steps: 5000,
      distanceKm: 4,
      activeEnergyKcal: 300,
      basalEnergyKcal: 1700,
    });
    mocks.client.getHrvSummary.mockRejectedValue(new Error("not available"));
    mocks.client.getTrainingStatus.mockRejectedValue(new Error("not available"));

    const result = await syncProvider(provider, db, new Date());

    expect(result.recordsSynced).toBe(1);

    const dailyCall = db.values.mock.calls.find((call) => call[0]?.steps === 5000);
    if (!dailyCall) throw new Error("expected daily metrics insert");
    expect(dailyCall[0].hrv).toBeUndefined();
    expect(dailyCall[0].vo2max).toBeUndefined();
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

    const stressCall = db.values.mock.calls.find((call) => call[0]?.stress === 35);
    if (!stressCall) throw new Error("expected stress insert");
    expect(stressCall[0].providerId).toBe("garmin");
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

    const hrCall = db.values.mock.calls.find((call) => call[0]?.heartRate === 72);
    if (!hrCall) throw new Error("expected heart rate insert");
    expect(hrCall[0].providerId).toBe("garmin");
  });

  it("syncs all data types together and sums record counts", async () => {
    mocks.client.getActivities.mockResolvedValue([{ activityId: 1 }]);
    mocks.parseConnectActivity.mockReturnValue({
      externalId: "1",
      activityType: "running",
      name: "Run",
      startedAt: new Date(),
      endedAt: new Date(),
      raw: {},
    });
    mocks.client.getActivityDetail.mockRejectedValue(new Error("no detail"));

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

    mocks.client.getDailySummary.mockResolvedValue({ privacyProtected: false });
    mocks.parseConnectDailySummary.mockReturnValue({
      date: "today",
      steps: 10000,
      distanceKm: 8,
      activeEnergyKcal: 500,
      basalEnergyKcal: 1800,
    });
    mocks.client.getHrvSummary.mockRejectedValue(new Error("n/a"));
    mocks.client.getTrainingStatus.mockRejectedValue(new Error("n/a"));

    mocks.client.getDailyStress.mockResolvedValue({});
    mocks.parseStressTimeSeries.mockReturnValue({
      samples: [{ timestamp: new Date(), stressLevel: 30 }],
    });

    mocks.client.getDailyHeartRate.mockResolvedValue({});
    mocks.parseHeartRateTimeSeries.mockReturnValue({
      samples: [{ timestamp: new Date(), heartRate: 65 }],
    });

    const result = await syncProvider(provider, db, new Date());

    // 1 activity + 1 sleep + 1 daily + 1 stress + 1 heart rate = 5
    expect(result.recordsSynced).toBe(5);
    expect(result.errors).toHaveLength(0);
    expect(result.provider).toBe("garmin");
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("handles individual sync method failures without failing the whole sync", async () => {
    mocks.withSyncLog.mockImplementation(
      async (
        _db: unknown,
        _pid: string,
        dataType: string,
        fn: () => Promise<{ result: unknown }>,
      ) => {
        if (dataType === "activities") {
          throw new Error("activities sync crashed");
        }
        const res = await fn();
        return res.result;
      },
    );

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
    );
  });

  it("uses sync cursor when available", async () => {
    db.limit.mockResolvedValueOnce([{ value: { cursor: "2026-02-15T00:00:00Z" } }]);

    await syncProvider(provider, db, new Date());

    expect(mocks.withSyncLog).toHaveBeenCalledTimes(5);
  });
});
