import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

// Restore real timers and any Date.now spy after each test so a failed
// assertion before an inline mockRestore() can't leak the mocked clock.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// cspell:ignore RESTEASY

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

const providerActivityAbsenceMocks = vi.hoisted(() => ({
  finishProviderActivityListSync: vi.fn().mockResolvedValue(undefined),
  upsertProviderActivity: vi.fn().mockResolvedValue({ id: "activity-id" }),
}));

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

vi.mock("../db/provider-activity-sync.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../db/provider-activity-sync.ts")>();
  return {
    ...original,
    finishProviderActivityListSync: providerActivityAbsenceMocks.finishProviderActivityListSync,
    upsertProviderActivity: providerActivityAbsenceMocks.upsertProviderActivity,
  };
});

import { ZwiftProvider } from "./zwift.ts";

// ============================================================
// Mock zwift-client module — preserves real pure-function
// implementations while mocking ZwiftClient class for sync tests
// ============================================================

const { MockZwiftClient } = vi.hoisted(() => {
  class MockZwiftClient {
    athleteId: string;

    static signInResult = {
      accessToken: "fake-header.eyJzdWIiOiI5OTk5OSJ9.fake",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    };
    static refreshResult = {
      accessToken: "refreshed-token",
      refreshToken: "new-refresh",
      expiresIn: 3600,
    };
    static activities: Array<Record<string, unknown>> = [];
    static repeatActivitiesForEveryOffset = false;
    static stopReturningActivitiesAtOffset: number | null = null;
    static activityOffsets: number[] = [];
    static activityDetail: Record<string, unknown> = {};
    static activityDetailError: Error | null = null;
    static fitnessData: Record<string, unknown> = {};
    static powerCurve: Record<string, unknown> = {};
    static authenticatedProfile: Record<string, unknown> = {
      id: 12345,
      firstName: "Test",
      lastName: "User",
      ftp: 250,
      weight: 72000,
      height: 180,
    };
    static getAuthenticatedProfileCalls = 0;

    constructor(_accessToken = "test-token", athleteId = "12345") {
      this.athleteId = athleteId;
    }

    static signIn = vi.fn().mockImplementation(async () => MockZwiftClient.signInResult);
    static refreshToken = vi.fn().mockImplementation(async () => MockZwiftClient.refreshResult);

    getActivities = vi.fn().mockImplementation(async (offset = 0) => {
      MockZwiftClient.activityOffsets.push(offset);
      if (!/^\d+$/.test(this.athleteId)) {
        throw new Error(
          `Zwift API error (404): RESTEASY003210: Could not find resource for full path: https://us-or-rly101.zwift.com/api/profiles/${this.athleteId}/activities`,
        );
      }
      if (
        MockZwiftClient.stopReturningActivitiesAtOffset !== null &&
        offset >= MockZwiftClient.stopReturningActivitiesAtOffset
      ) {
        return [];
      }
      return offset === 0 || MockZwiftClient.repeatActivitiesForEveryOffset
        ? MockZwiftClient.activities
        : [];
    });
    getActivityDetail = vi.fn().mockImplementation(async () => {
      if (MockZwiftClient.activityDetailError) {
        throw MockZwiftClient.activityDetailError;
      }
      return MockZwiftClient.activityDetail;
    });
    getFitnessData = vi.fn().mockImplementation(async () => MockZwiftClient.fitnessData);
    getPowerCurve = vi.fn().mockImplementation(async () => MockZwiftClient.powerCurve);
    getAuthenticatedProfile = vi.fn().mockImplementation(async () => {
      MockZwiftClient.getAuthenticatedProfileCalls += 1;
      return MockZwiftClient.authenticatedProfile;
    });
  }
  return { MockZwiftClient };
});

vi.mock("@dofek/zwift/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@dofek/zwift/client")>();
  return { ...real, ZwiftClient: MockZwiftClient };
});

const { mapZwiftSport, parseZwiftActivity, parseZwiftFitnessData } =
  await vi.importActual<typeof import("@dofek/zwift/parsing")>("@dofek/zwift/parsing");

// ============================================================
// Sample API responses
// ============================================================

const sampleActivity = {
  id: 123456789,
  id_str: "123456789",
  profileId: 99999,
  name: "Watopia Hilly Route",
  startDate: "2026-03-01T18:00:00.000Z",
  endDate: "2026-03-01T19:00:00.000Z",
  distanceInMeters: 35000,
  avgHeartRate: 155,
  maxHeartRate: 180,
  avgWatts: 220,
  maxWatts: 550,
  avgCadenceInRotationsPerMinute: 85,
  avgSpeedInMetersPerSecond: 9.72,
  maxSpeedInMetersPerSecond: 15.5,
  totalElevationInMeters: 450,
  calories: 800,
  sport: "CYCLING",
  rideOnGiven: 5,
  activityRideOnCount: 12,
};

const sampleFitnessData = {
  powerInWatts: [200, 220, 250, 180, 300],
  heartRate: [140, 145, 155, 150, 165],
  cadencePerMin: [85, 88, 90, 82, 95],
  distanceInCm: [0, 97200, 194400, 291600, 388800],
  speedInCmPerSec: [972, 972, 972, 972, 972],
  altitudeInCm: [5000, 5100, 5250, 5200, 5300],
  latlng: [
    [40.7128, -74.006],
    [40.713, -74.005],
    [40.714, -74.004],
    [40.715, -74.003],
    [40.716, -74.002],
  ] satisfies Array<[number, number]>,
  timeInSec: [0, 1, 2, 3, 4],
};

// ============================================================
// Helper to build a mock DB for sync tests
// ============================================================

function makeMockDb(
  options: {
    tokens?: {
      accessToken: string;
      refreshToken: string | null;
      expiresAt: Date;
      scopes: string | null;
    } | null;
  } = {},
) {
  const tokens = options.tokens ?? null;

  let selectCallCount = 0;
  const select = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(() => ({
        limit: vi.fn().mockImplementation(() => {
          selectCallCount++;
          if (selectCallCount === 1) {
            return Promise.resolve(tokens ? [tokens] : []);
          }
          return Promise.resolve([]);
        }),
      })),
    })),
  }));

  const insertValues = vi.fn();
  const onConflictDoUpdate = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([{ id: "activity-1" }]),
  });
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  insertValues.mockReturnValue({ onConflictDoUpdate, onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  const deleteFn = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  });

  const execute = vi.fn().mockResolvedValue([]);
  return { insert, select, delete: deleteFn, execute, _insertValues: insertValues };
}

// ============================================================
// Pure function tests (use real zwift-client implementations)
// ============================================================

describe("Zwift Provider", () => {
  describe("mapZwiftSport", () => {
    it("maps cycling", () => {
      expect(mapZwiftSport("CYCLING").canonicalType).toBe("cycling");
    });

    it("maps running", () => {
      expect(mapZwiftSport("RUNNING").canonicalType).toBe("running");
    });

    it("maps unknown sports to other", () => {
      expect(mapZwiftSport("ROWING").canonicalType).toBe("other");
      expect(mapZwiftSport("").canonicalType).toBe("other");
    });

    it("is case-insensitive", () => {
      expect(mapZwiftSport("cycling").canonicalType).toBe("cycling");
      expect(mapZwiftSport("Running").canonicalType).toBe("running");
    });
  });

  describe("parseZwiftActivity", () => {
    it("maps activity fields correctly", () => {
      const result = parseZwiftActivity(sampleActivity);

      expect(result.externalId).toBe("123456789");
      expect(result.activityType.canonicalType).toBe("cycling");
      expect(result.name).toBe("Watopia Hilly Route");
      expect(result.startedAt).toEqual(new Date("2026-03-01T18:00:00.000Z"));
      expect(result.endedAt).toEqual(new Date("2026-03-01T19:00:00.000Z"));
    });

    it("stores key metrics in raw object", () => {
      const result = parseZwiftActivity(sampleActivity);

      expect(result.raw.avgWatts).toBe(220);
      expect(result.raw.maxWatts).toBe(550);
      expect(result.raw.avgHeartRate).toBe(155);
      expect(result.raw.maxHeartRate).toBe(180);
      expect(result.raw.distanceMeters).toBe(35000);
      expect(result.raw.elevationGain).toBe(450);
    });

    it("uses id_str when available", () => {
      const result = parseZwiftActivity(sampleActivity);
      expect(result.externalId).toBe("123456789");
    });

    it("falls back to id when id_str is empty", () => {
      const noIdStr = { ...sampleActivity, id_str: "" };
      const result = parseZwiftActivity(noIdStr);
      expect(result.externalId).toBe("123456789");
    });
  });

  describe("parseZwiftFitnessData", () => {
    const activityStart = new Date("2026-03-01T18:00:00.000Z");

    it("parses all stream channels", () => {
      const result = parseZwiftFitnessData(sampleFitnessData, activityStart);

      expect(result).toHaveLength(5);
      expect(result[0]).toEqual({
        recordedAt: new Date("2026-03-01T18:00:00.000Z"),
        heartRate: 140,
        power: 200,
        cadence: 85,
        speed: 9.72, // 972 cm/s → 9.72 m/s
        altitude: 50, // 5000 cm → 50 m
        distance: 0,
        lat: 40.7128,
        lng: -74.006,
      });
    });

    it("converts cm/s to m/s for speed", () => {
      const result = parseZwiftFitnessData(sampleFitnessData, activityStart);
      expect(result[0]?.speed).toBe(9.72);
    });

    it("converts cm to m for altitude", () => {
      const result = parseZwiftFitnessData(sampleFitnessData, activityStart);
      expect(result[0]?.altitude).toBe(50);
      expect(result[2]?.altitude).toBe(52.5);
    });

    it("converts cm to m for distance", () => {
      const result = parseZwiftFitnessData(sampleFitnessData, activityStart);
      expect(result[1]?.distance).toBe(972);
    });

    it("calculates timestamps from timeInSec offsets", () => {
      const result = parseZwiftFitnessData(sampleFitnessData, activityStart);
      expect(result[0]?.recordedAt).toEqual(new Date("2026-03-01T18:00:00.000Z"));
      expect(result[4]?.recordedAt).toEqual(new Date("2026-03-01T18:00:04.000Z"));
    });

    it("handles missing optional fields", () => {
      const partialData = {
        powerInWatts: [200, 220],
        timeInSec: [0, 1],
      };
      const result = parseZwiftFitnessData(partialData, activityStart);

      expect(result).toHaveLength(2);
      expect(result[0]?.power).toBe(200);
      expect(result[0]?.heartRate).toBeUndefined();
      expect(result[0]?.cadence).toBeUndefined();
      expect(result[0]?.lat).toBeUndefined();
    });

    it("handles empty fitness data", () => {
      const result = parseZwiftFitnessData({}, activityStart);
      expect(result).toHaveLength(0);
    });
  });
});

// ============================================================
// Sync & auth tests (use mocked ZwiftClient)
// ============================================================

describe("ZwiftProvider.sync() — token resolution", () => {
  it("returns error when token expired and refresh fails", async () => {
    MockZwiftClient.signIn.mockClear();
    MockZwiftClient.refreshToken.mockRejectedValueOnce(new Error("refresh failed"));

    const db = makeMockDb({
      tokens: {
        accessToken: "old-token",
        refreshToken: "old-refresh",
        expiresAt: new Date("2020-01-01"), // expired
        scopes: "athleteId:12345",
      },
    });

    const provider = new ZwiftProvider();
    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("refreshes token when expired and has refresh token", async () => {
    MockZwiftClient.refreshToken.mockResolvedValueOnce({
      accessToken: "refreshed",
      refreshToken: "new-refresh",
      expiresIn: 3600,
    });
    MockZwiftClient.activities = [];
    MockZwiftClient.powerCurve = {};

    const db = makeMockDb({
      tokens: {
        accessToken: "old-token",
        refreshToken: "old-refresh",
        expiresAt: new Date("2020-01-01"), // expired
        scopes: "athleteId:12345",
      },
    });

    const provider = new ZwiftProvider();
    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    // Should proceed (no "token expired" error, just possibly empty results)
    expect(result.provider).toBe("zwift");
  });

  it("resolves UUID athlete ID in scopes to numeric profile ID", async () => {
    MockZwiftClient.activities = [];
    MockZwiftClient.powerCurve = {};
    MockZwiftClient.getAuthenticatedProfileCalls = 0;
    MockZwiftClient.authenticatedProfile = {
      id: 12345,
      firstName: "Test",
      lastName: "User",
      ftp: 250,
      weight: 72000,
      height: 180,
    };

    const db = makeMockDb({
      tokens: {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2099-01-01"),
        scopes: "athleteId:a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      },
    });

    const provider = new ZwiftProvider();
    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.provider).toBe("zwift");
    expect(result.errors).toHaveLength(0);
    expect(MockZwiftClient.getAuthenticatedProfileCalls).toBeGreaterThan(0);
  });
});

describe("ZwiftProvider.sync() — activity sync", () => {
  beforeEach(() => {
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();
    MockZwiftClient.repeatActivitiesForEveryOffset = false;
    MockZwiftClient.stopReturningActivitiesAtOffset = null;
    MockZwiftClient.activityOffsets = [];
    MockZwiftClient.activityDetailError = null;
  });

  it("syncs activities and metric streams", async () => {
    MockZwiftClient.activities = [sampleActivity];
    MockZwiftClient.activityDetail = {
      fitnessData: { fullDataUrl: "https://zwift.com/fitness/123456789" },
    };
    MockZwiftClient.fitnessData = sampleFitnessData;

    const db = makeMockDb({
      tokens: {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2099-01-01"),
        scopes: "athleteId:12345",
      },
    });

    const provider = new ZwiftProvider();
    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.provider).toBe("zwift");
    expect(result.recordsSynced).toBe(1);
  });

  it("handles stream fetch error gracefully (non-fatal)", async () => {
    MockZwiftClient.activities = [
      {
        ...sampleActivity,
        id: 456,
        id_str: "456",
        name: "Error Ride",
        startDate: "2026-03-15T18:00:00Z",
        endDate: "2026-03-15T19:00:00Z",
      },
    ];

    MockZwiftClient.activityDetailError = new Error("stream fetch failed");

    MockZwiftClient.powerCurve = {};

    const db = makeMockDb({
      tokens: {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2099-01-01"),
        scopes: "athleteId:12345",
      },
    });

    const provider = new ZwiftProvider();
    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    // The activity itself still counted even if streams fail
    expect(result.provider).toBe("zwift");
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toEqual([
      {
        message: "streams 456: stream fetch failed",
        externalId: "456",
        cause: expect.any(Error),
        context: {
          activityId: "456",
        },
      },
    ]);
  });

  it("stops syncing when activity is before since date", async () => {
    MockZwiftClient.activities = [
      {
        id: 789,
        name: "Old Ride",
        startDate: "2020-01-01T10:00:00Z",
        endDate: "2020-01-01T11:00:00Z",
      },
    ];
    MockZwiftClient.powerCurve = {};

    const db = makeMockDb({
      tokens: {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2099-01-01"),
        scopes: "athleteId:12345",
      },
    });

    const provider = new ZwiftProvider();
    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.provider).toBe("zwift");
    expect(result.recordsSynced).toBe(0);
    expect(providerActivityAbsenceMocks.upsertProviderActivity).not.toHaveBeenCalled();
  });

  it("skips activities after the sync window end", async () => {
    MockZwiftClient.activities = [
      {
        id: 100,
        name: "In Window",
        sport: "CYCLING",
        startDate: "2026-03-01T08:00:00Z",
        endDate: "2026-03-01T09:00:00Z",
      },
      {
        id: 200,
        name: "After Window",
        sport: "CYCLING",
        startDate: "2026-03-03T08:00:00Z",
        endDate: "2026-03-03T09:00:00Z",
      },
    ];
    MockZwiftClient.powerCurve = {};
    MockZwiftClient.activityDetail = { fitnessData: {} };

    const db = makeMockDb({
      tokens: {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2099-01-01"),
        scopes: "athleteId:12345",
      },
    });

    const provider = new ZwiftProvider();
    const result = await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "100" }),
      expect.any(Object),
    );
    expect(providerActivityAbsenceMocks.upsertProviderActivity).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "200" }),
      expect.any(Object),
    );
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        presentExternalIds: new Set(["100"]),
      }),
    );
  });

  it("stops with degraded pagination when a full page keeps advancing", async () => {
    MockZwiftClient.repeatActivitiesForEveryOffset = true;
    MockZwiftClient.activities = Array.from({ length: 20 }, (_, index) => ({
      ...sampleActivity,
      id: index + 1,
      id_str: String(index + 1),
    }));
    MockZwiftClient.powerCurve = {};
    MockZwiftClient.activityDetail = { fitnessData: {} };

    const db = makeMockDb({
      tokens: {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2099-01-01"),
        scopes: "athleteId:12345",
      },
    });

    const provider = new ZwiftProvider();
    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.degradations).toEqual([
      expect.objectContaining({
        kind: "pagination_max_pages_exceeded",
        providerId: "zwift",
        stepName: "activity_list",
        message: "Provider pagination exceeded the maximum page count",
        context: {
          cursorFingerprint: expect.any(String),
          pagesFetched: 100,
        },
      }),
    ]);
    expect(MockZwiftClient.activityOffsets).toHaveLength(100);
    expect(MockZwiftClient.activityOffsets[0]).toBe(0);
    expect(MockZwiftClient.activityOffsets.at(-1)).toBe(1980);
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("treats a partial activity page as a complete list without degradation", async () => {
    MockZwiftClient.repeatActivitiesForEveryOffset = true;
    MockZwiftClient.stopReturningActivitiesAtOffset = 2000;
    MockZwiftClient.activities = Array.from({ length: 19 }, (_, index) => ({
      ...sampleActivity,
      id: index + 1,
      id_str: String(index + 1),
      startDate: "2026-03-03T08:00:00Z",
      endDate: "2026-03-03T09:00:00Z",
    }));
    MockZwiftClient.powerCurve = {};
    MockZwiftClient.activityDetail = { fitnessData: {} };

    const db = makeMockDb({
      tokens: {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2099-01-01"),
        scopes: "athleteId:12345",
      },
    });

    const provider = new ZwiftProvider();
    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.degradations).toBeUndefined();
    expect(MockZwiftClient.activityOffsets).toEqual([0]);
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        presentExternalIds: new Set(Array.from({ length: 19 }, (_, index) => String(index + 1))),
      }),
    );
  });
});

describe("ZwiftProvider.sync() — power curve sync", () => {
  it("skips power curve insert when no zFtp and no vo2Max", async () => {
    MockZwiftClient.activities = [];
    MockZwiftClient.powerCurve = {};

    const db = makeMockDb({
      tokens: {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2099-01-01"),
        scopes: "athleteId:12345",
      },
    });

    const provider = new ZwiftProvider();
    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.provider).toBe("zwift");
    // recordsSynced should be 0 since nothing was synced
    expect(result.recordsSynced).toBe(0);
  });
});

describe("ZwiftProvider.authSetup() — automatedLogin", () => {
  it("calls signIn and returns token set with athleteId in scopes", async () => {
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(new Date("2026-01-01T00:00:00Z").getTime());
    const mockFetch: typeof globalThis.fetch = vi.fn(async () => Response.json({}));
    MockZwiftClient.signIn.mockResolvedValueOnce({
      accessToken: "fake-header.eyJzdWIiOiI1NTU1NSJ9.fake",
      refreshToken: "refresh-123",
      expiresIn: 3600,
    });

    const provider = new ZwiftProvider(mockFetch);
    const setup = provider.authSetup();
    const result = await setup.automatedLogin?.("user@example.com", "password123");

    // signIn receives the provider's rate-limit-wrapped fetch, which delegates to mockFetch.
    expect(MockZwiftClient.signIn).toHaveBeenCalledWith(
      "user@example.com",
      "password123",
      expect.any(Function),
    );
    const passedFetch = MockZwiftClient.signIn.mock.calls[0]?.[2];
    if (!passedFetch) throw new Error("expected a fetch passed to signIn");
    await passedFetch("https://example.com");
    expect(mockFetch).toHaveBeenCalled();
    expect(result?.accessToken).toContain("eyJ");
    expect(result?.refreshToken).toBe("refresh-123");
    expect(result?.expiresAt).toEqual(new Date("2026-01-01T01:00:00Z"));
    expect(result?.scopes).toBe("athleteId:55555");
    nowSpy.mockRestore();
  });

  it("handles UUID sub claim in JWT", async () => {
    const uuidPayload = Buffer.from(
      JSON.stringify({ sub: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
    ).toString("base64url");
    MockZwiftClient.getAuthenticatedProfileCalls = 0;
    MockZwiftClient.authenticatedProfile = {
      id: 12345,
      firstName: "Test",
      lastName: "User",
      ftp: 250,
      weight: 72000,
      height: 180,
    };

    MockZwiftClient.signIn.mockResolvedValueOnce({
      accessToken: `fake-header.${uuidPayload}.fake`,
      refreshToken: "refresh-uuid",
      expiresIn: 3600,
    });

    const provider = new ZwiftProvider();
    const setup = provider.authSetup();
    const result = await setup.automatedLogin?.("rider@example.com", "fake-test-pw");

    expect(result?.scopes).toBe("athleteId:12345");
    expect(MockZwiftClient.getAuthenticatedProfileCalls).toBeGreaterThan(0);
  });

  it("throws when JWT has no sub claim", async () => {
    const noSubPayload = Buffer.from(JSON.stringify({})).toString("base64url");

    MockZwiftClient.signIn.mockResolvedValueOnce({
      accessToken: `fake-header.${noSubPayload}.fake`,
      refreshToken: "refresh-no-sub",
      expiresIn: 3600,
    });

    const provider = new ZwiftProvider();
    const setup = provider.authSetup();
    await expect(setup.automatedLogin?.("rider@example.com", "fake-test-pw")).rejects.toThrow(
      "athlete ID",
    );
  });
});

describe("ZwiftProvider", () => {
  it("validate returns null", () => {
    expect(new ZwiftProvider().validate()).toBeNull();
  });

  it("authSetup returns credential-only configuration", () => {
    const setup = new ZwiftProvider().authSetup();
    expect(setup.automatedLogin).toBeTypeOf("function");
    expect(setup.oauthConfig).toBeUndefined();
    expect(setup.exchangeCode).toBeUndefined();
  });

  it("sync returns error when no tokens stored", async () => {
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

    const provider = new ZwiftProvider();
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.provider).toBe("zwift");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("not connected");
  });

  it("sync returns error when athleteId missing from stored tokens and JWT has no sub", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                providerId: "zwift",
                accessToken: "not-a-jwt",
                refreshToken: "refresh",
                expiresAt: new Date("2099-01-01"),
                scopes: null,
              },
            ]),
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

    const provider = new ZwiftProvider();
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.errors[0]?.message).toContain("athlete ID not found");
    expect(result.errors[0]?.cause).toMatchObject({ authFailureReason: "authentication_failed" });
  });

  it("self-heals missing scopes by extracting athleteId from JWT sub claim", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "12345" })).toString("base64url");
    const fakeJwt = `${header}.${payload}.fake-signature`;

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                providerId: "zwift",
                accessToken: fakeJwt,
                refreshToken: "refresh",
                expiresAt: new Date("2099-01-01"),
                scopes: null,
              },
            ]),
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

    MockZwiftClient.activities = [];
    MockZwiftClient.powerCurve = {};

    const mockFetch: typeof globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const provider = new ZwiftProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    const athleteIdErrors = result.errors.filter((error) =>
      error.message.includes("athlete ID not found"),
    );
    expect(athleteIdErrors).toHaveLength(0);
  });

  it("sync returns error when token expired and no refresh token", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                providerId: "zwift",
                accessToken: "old-token",
                refreshToken: null,
                expiresAt: new Date("2020-01-01"),
                scopes: "athleteId:12345",
              },
            ]),
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

    const provider = new ZwiftProvider();
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.errors[0]?.message).toContain("Zwift authentication failed.");
    expect(result.errors[0]?.cause).toMatchObject({ authFailureReason: "authentication_failed" });
  });
});
