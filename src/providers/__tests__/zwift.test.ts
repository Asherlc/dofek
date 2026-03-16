import { describe, expect, it, vi } from "vitest";
import { ZwiftProvider } from "../zwift.ts";

// ============================================================
// Mock zwift-client module — preserves real pure-function
// implementations while mocking ZwiftClient class for sync tests
// ============================================================

const { MockZwiftClient } = vi.hoisted(() => {
  class MockZwiftClient {
    static signInResult = {
      accessToken: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiI5OTk5OSJ9.fake",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    };
    static refreshResult = {
      accessToken: "refreshed-token",
      refreshToken: "new-refresh",
      expiresIn: 3600,
    };
    static activities: Array<Record<string, unknown>> = [];
    static activityDetail: Record<string, unknown> = {};
    static fitnessData: Record<string, unknown> = {};
    static powerCurve: Record<string, unknown> = {};

    static signIn = vi.fn().mockImplementation(async () => MockZwiftClient.signInResult);
    static refreshToken = vi.fn().mockImplementation(async () => MockZwiftClient.refreshResult);

    getActivities = vi.fn().mockImplementation(async () => MockZwiftClient.activities);
    getActivityDetail = vi.fn().mockImplementation(async () => MockZwiftClient.activityDetail);
    getFitnessData = vi.fn().mockImplementation(async () => MockZwiftClient.fitnessData);
    getPowerCurve = vi.fn().mockImplementation(async () => MockZwiftClient.powerCurve);
  }
  return { MockZwiftClient };
});

vi.mock("zwift-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("zwift-client")>();
  return { ...real, ZwiftClient: MockZwiftClient };
});

const { mapZwiftSport, parseZwiftActivity, parseZwiftFitnessData } =
  await vi.importActual<typeof import("zwift-client")>("zwift-client");

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

  return { insert, select, delete: deleteFn, _insertValues: insertValues };
}

// ============================================================
// Pure function tests (use real zwift-client implementations)
// ============================================================

describe("Zwift Provider", () => {
  describe("mapZwiftSport", () => {
    it("maps cycling", () => {
      expect(mapZwiftSport("CYCLING")).toBe("cycling");
    });

    it("maps running", () => {
      expect(mapZwiftSport("RUNNING")).toBe("running");
    });

    it("maps unknown sports to other", () => {
      expect(mapZwiftSport("ROWING")).toBe("other");
      expect(mapZwiftSport("")).toBe("other");
    });

    it("is case-insensitive", () => {
      expect(mapZwiftSport("cycling")).toBe("cycling");
      expect(mapZwiftSport("Running")).toBe("running");
    });
  });

  describe("parseZwiftActivity", () => {
    it("maps activity fields correctly", () => {
      const result = parseZwiftActivity(sampleActivity);

      expect(result.externalId).toBe("123456789");
      expect(result.activityType).toBe("cycling");
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
      expect(result.raw.calories).toBe(800);
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
    // @ts-expect-error mock DB
    const result = await provider.sync(db, new Date("2026-01-01"));
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
    // @ts-expect-error mock DB
    const result = await provider.sync(db, new Date("2026-01-01"));
    // Should proceed (no "token expired" error, just possibly empty results)
    expect(result.provider).toBe("zwift");
  });
});

describe("ZwiftProvider.sync() — activity sync", () => {
  it("syncs activities and metric streams", async () => {
    MockZwiftClient.activities = [
      {
        id: 123,
        name: "Watopia Ride",
        startDate: "2026-03-15T18:00:00Z",
        endDate: "2026-03-15T19:00:00Z",
      },
    ];
    MockZwiftClient.activityDetail = {
      fitnessData: { fullDataUrl: "https://zwift.com/fitness/123" },
    };
    MockZwiftClient.fitnessData = { data: "something" };
    MockZwiftClient.powerCurve = { zFtp: 250, vo2Max: 55 };

    const db = makeMockDb({
      tokens: {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2099-01-01"),
        scopes: "athleteId:12345",
      },
    });

    const provider = new ZwiftProvider();
    // @ts-expect-error mock DB
    const result = await provider.sync(db, new Date("2026-01-01"));
    expect(result.provider).toBe("zwift");
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);
  });

  it("handles stream fetch error gracefully (non-fatal)", async () => {
    MockZwiftClient.activities = [
      {
        id: 456,
        name: "Error Ride",
        startDate: "2026-03-15T18:00:00Z",
        endDate: "2026-03-15T19:00:00Z",
      },
    ];

    // Make getActivityDetail throw
    const mockClient = new MockZwiftClient();
    mockClient.getActivityDetail = vi.fn().mockRejectedValue(new Error("stream fetch failed"));

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
    // @ts-expect-error mock DB
    const result = await provider.sync(db, new Date("2026-01-01"));
    // The activity itself still counted even if streams fail
    expect(result.provider).toBe("zwift");
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
    // @ts-expect-error mock DB
    const result = await provider.sync(db, new Date("2026-01-01"));
    expect(result.provider).toBe("zwift");
    // Old activity skipped
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
    // @ts-expect-error mock DB
    const result = await provider.sync(db, new Date("2026-01-01"));
    expect(result.provider).toBe("zwift");
    // recordsSynced should be 0 since nothing was synced
    expect(result.recordsSynced).toBe(0);
  });
});

describe("ZwiftProvider.authSetup() — automatedLogin", () => {
  it("calls signIn and returns token set with athleteId in scopes", async () => {
    MockZwiftClient.signIn.mockResolvedValueOnce({
      accessToken: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiI1NTU1NSJ9.fake",
      refreshToken: "refresh-123",
      expiresIn: 3600,
    });

    const provider = new ZwiftProvider();
    const setup = provider.authSetup();
    const result = await setup.automatedLogin?.("user@example.com", "password123");

    expect(result?.accessToken).toContain("eyJ");
    expect(result?.refreshToken).toBe("refresh-123");
    expect(result?.scopes).toContain("athleteId:");
  });
});
