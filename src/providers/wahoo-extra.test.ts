import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

import {
  fitRecordsToMetricStream,
  parseWorkoutList,
  parseWorkoutSummary,
  WahooClient,
  WahooProvider,
  type WahooWorkout,
} from "./wahoo.ts";

// ============================================================
// Tests targeting uncovered sync paths in wahoo.ts
// ============================================================

describe("WahooClient.getWorkout", () => {
  it("fetches a single workout by ID", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json({
        workout: {
          id: 42,
          workout_type_id: 0,
          starts: "2026-03-01T10:00:00Z",
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        },
      }),
    );

    const client = new WahooClient("test-token", mockFetch);
    const result = await client.getWorkout(42);
    expect(result.workout.id).toBe(42);
    expect(mockFetch).toHaveBeenCalledOnce();
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/workouts/42");
  });
});

describe("WahooClient.downloadFitFile", () => {
  it("downloads and returns a Buffer", async () => {
    const testData = new Uint8Array([0x2e, 0x46, 0x49, 0x54]);
    const mockFetch = vi.fn().mockResolvedValue(new Response(testData, { status: 200 }));

    const client = new WahooClient("test-token", mockFetch);
    const result = await client.downloadFitFile("https://example.com/test.fit");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(4);
  });
});

describe("fitRecordsToMetricStream", () => {
  it("maps FIT records to metric_stream rows", () => {
    const records = [
      {
        recordedAt: new Date("2026-03-01T10:00:00Z"),
        heartRate: 140,
        power: 200,
        cadence: 85,
        speed: 8.5,
        lat: 40.7,
        lng: -74.0,
        altitude: 50,
        temperature: 22,
        distance: 1000,
        grade: 1.5,
        calories: 100,
        verticalSpeed: 0.5,
        gpsAccuracy: 3,
        accumulatedPower: 5000,
        leftRightBalance: 50,
        verticalOscillation: 8.2,
        stanceTime: 250,
        stanceTimePercent: 35,
        stepLength: 1.2,
        verticalRatio: 7.5,
        stanceTimeBalance: 50.5,
        leftTorqueEffectiveness: 75,
        rightTorqueEffectiveness: 72,
        leftPedalSmoothness: 20,
        rightPedalSmoothness: 19,
        combinedPedalSmoothness: 19.5,
        raw: { extra: "data" },
      },
    ];

    const rows = fitRecordsToMetricStream(records, "wahoo", "act-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerId).toBe("wahoo");
    expect(rows[0]?.activityId).toBe("act-1");
    expect(rows[0]?.heartRate).toBe(140);
    expect(rows[0]?.power).toBe(200);
    expect(rows[0]?.cadence).toBe(85);
    expect(rows[0]?.speed).toBe(8.5);
    expect(rows[0]?.lat).toBe(40.7);
    expect(rows[0]?.lng).toBe(-74.0);
    expect(rows[0]?.altitude).toBe(50);
    expect(rows[0]?.temperature).toBe(22);
    expect(rows[0]?.grade).toBe(1.5);
    expect(rows[0]?.verticalSpeed).toBe(0.5);
    expect(rows[0]?.leftTorqueEffectiveness).toBe(75);
    expect(rows[0]?.combinedPedalSmoothness).toBe(19.5);
  });

  it("handles records with undefined optional fields", () => {
    const records = [
      {
        recordedAt: new Date("2026-03-01T10:00:00Z"),
        heartRate: undefined,
        power: undefined,
        cadence: undefined,
        speed: undefined,
        lat: undefined,
        lng: undefined,
        altitude: undefined,
        temperature: undefined,
        distance: undefined,
        grade: undefined,
        calories: undefined,
        verticalSpeed: undefined,
        gpsAccuracy: undefined,
        accumulatedPower: undefined,
        leftRightBalance: undefined,
        verticalOscillation: undefined,
        stanceTime: undefined,
        stanceTimePercent: undefined,
        stepLength: undefined,
        verticalRatio: undefined,
        stanceTimeBalance: undefined,
        leftTorqueEffectiveness: undefined,
        rightTorqueEffectiveness: undefined,
        leftPedalSmoothness: undefined,
        rightPedalSmoothness: undefined,
        combinedPedalSmoothness: undefined,
        raw: {},
      },
    ];

    const rows = fitRecordsToMetricStream(records, "wahoo", "act-2");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.heartRate).toBeUndefined();
    expect(rows[0]?.power).toBeUndefined();
  });
});

describe("parseWorkoutList", () => {
  it("calculates hasMore correctly when page * per_page < total", () => {
    const response = {
      workouts: [
        {
          id: 1,
          workout_type_id: 0,
          starts: "2026-03-01T10:00:00Z",
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        },
      ],
      total: 100,
      page: 1,
      per_page: 30,
      order: "desc",
      sort: "starts",
    };

    const result = parseWorkoutList(response);
    expect(result.hasMore).toBe(true);
    expect(result.total).toBe(100);
    expect(result.page).toBe(1);
  });

  it("calculates hasMore when all fetched", () => {
    const response = {
      workouts: [
        {
          id: 1,
          workout_type_id: 1,
          starts: "2026-03-01T10:00:00Z",
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        },
      ],
      total: 30,
      page: 1,
      per_page: 30,
      order: "desc",
      sort: "starts",
    };

    const result = parseWorkoutList(response);
    expect(result.hasMore).toBe(false);
  });
});

describe("WahooProvider.sync — token error path", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when no tokens found", async () => {
    process.env.WAHOO_CLIENT_ID = "id";
    process.env.WAHOO_CLIENT_SECRET = "secret";

    const provider = new WahooProvider(vi.fn());
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.provider).toBe("wahoo");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
  });
});

// ============================================================
// WahooProvider.sync — happy path and mutation-killing tests
// ============================================================

function makeTokenRow(opts?: { expired?: boolean }) {
  const expiresAt = opts?.expired
    ? new Date("2020-01-01T00:00:00Z")
    : new Date("2099-01-01T00:00:00Z");
  return {
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt,
    scopes: "user_read workouts_read",
  };
}

function makeWorkoutApiResponse(
  workouts: WahooWorkout[],
  opts?: { page?: number; total?: number; perPage?: number },
) {
  const perPage = opts?.perPage ?? 30;
  const total = opts?.total ?? workouts.length;
  const page = opts?.page ?? 1;
  return { workouts, total, page, per_page: perPage, order: "descending", sort: "starts" };
}

const sampleWahooWorkout: WahooWorkout = {
  id: 42,
  name: "Morning Ride",
  workout_type_id: 0,
  starts: "2026-03-01T08:00:00.000Z",
  minutes: 92,
  created_at: "2026-03-01T10:00:00.000Z",
  updated_at: "2026-03-01T10:30:00.000Z",
  workout_summary: {
    id: 101,
    duration_total_accum: 5520,
    created_at: "2026-03-01T10:00:00.000Z",
    updated_at: "2026-03-01T10:30:00.000Z",
    file: { url: "https://cdn.wahoo.com/files/123.fit" },
  },
};

const sampleWahooWorkoutNoFit: WahooWorkout = {
  id: 43,
  name: "Evening Walk",
  workout_type_id: 8,
  starts: "2026-03-02T18:00:00.000Z",
  minutes: 30,
  created_at: "2026-03-02T19:00:00.000Z",
  updated_at: "2026-03-02T19:30:00.000Z",
};

function makeInsertMock(returnId = "act-uuid") {
  return vi.fn().mockReturnValue({
    values: vi.fn().mockImplementation(() => {
      return Object.assign(Promise.resolve(), {
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: returnId }]),
        }),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      });
    }),
  });
}

function makeSelectMock(
  tokenRow: {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date;
    scopes: string;
  } | null,
) {
  const rows = tokenRow ? [tokenRow] : [];
  return vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

describe("WahooProvider.sync — happy path (no FIT file)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("syncs a workout without a FIT file and increments recordsSynced", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const workoutsResponse = makeWorkoutApiResponse([sampleWahooWorkoutNoFit]);
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        return Promise.resolve(Response.json(workoutsResponse));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01T00:00:00Z"));

    expect(result.provider).toBe("wahoo");
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it("returns zero recordsSynced when the workout list is empty", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const workoutsResponse = makeWorkoutApiResponse([]);
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        return Promise.resolve(Response.json(workoutsResponse));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01T00:00:00Z"));

    expect(result.provider).toBe("wahoo");
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("WahooProvider.sync — expired token refresh path", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("refreshes expired tokens, saves new tokens, and continues sync", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const expiredTokenRow = makeTokenRow({ expired: true });
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(expiredTokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const workoutsResponse = makeWorkoutApiResponse([sampleWahooWorkoutNoFit]);
    const mockFetch = vi
      .fn()
      .mockImplementation((url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
        if (urlStr.includes("oauth/token") && init?.method === "POST") {
          return Promise.resolve(
            Response.json({
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              expires_in: 7200,
              scope: "user_read workouts_read",
            }),
          );
        }
        if (urlStr.includes("/v1/workouts")) {
          return Promise.resolve(Response.json(workoutsResponse));
        }
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      });

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01T00:00:00Z"));

    expect(result.provider).toBe("wahoo");
    expect(result.errors).toHaveLength(0);

    // Verify the OAuth token refresh was called
    const oauthCall = mockFetch.mock.calls.find(([url, init]) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      return (
        urlStr.includes("oauth/token") &&
        init != null &&
        typeof init === "object" &&
        "method" in init &&
        init.method === "POST"
      );
    });
    expect(oauthCall).toBeDefined();

    // Verify tokens were saved (insert called for oauthToken upsert)
    expect(mockInsert).toHaveBeenCalled();
  });

  it("returns error when refresh token is missing on expired tokens", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const expiredNoRefreshRow = {
      accessToken: "expired-token",
      refreshToken: null,
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      scopes: "user_read workouts_read",
    };

    const mockDb = {
      select: makeSelectMock(expiredNoRefreshRow),
      insert: makeInsertMock(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const mockFetch = vi.fn();
    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No refresh token");
    expect(result.recordsSynced).toBe(0);
  });
});

describe("WahooProvider.sync — since date boundary", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("skips workouts with startedAt before since date and stops pagination", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    // Workout starts before the since date
    const oldWorkout: WahooWorkout = {
      ...sampleWahooWorkoutNoFit,
      id: 99,
      starts: "2025-06-01T08:00:00.000Z",
    };

    const workoutsResponse = makeWorkoutApiResponse([oldWorkout], { total: 50 });
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        return Promise.resolve(Response.json(workoutsResponse));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const provider = new WahooProvider(mockFetch);
    // since is after the workout's starts
    const result = await provider.sync(mockDb, new Date("2026-01-01T00:00:00Z"));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
    // Only one workouts API call made (pagination stopped)
    const workoutCalls = mockFetch.mock.calls.filter(([url]) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      return urlStr.includes("/v1/workouts");
    });
    expect(workoutCalls).toHaveLength(1);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("WahooProvider.sync — onProgress callback", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("calls onProgress after each workout is inserted", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const workoutsResponse = makeWorkoutApiResponse([sampleWahooWorkoutNoFit], { total: 1 });
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        return Promise.resolve(Response.json(workoutsResponse));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const onProgress = vi.fn();
    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01T00:00:00Z"), { onProgress });

    expect(result.recordsSynced).toBe(1);
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress.mock.calls[0]?.[0]).toBe(100);
    expect(typeof onProgress.mock.calls[0]?.[1]).toBe("string");
    expect(String(onProgress.mock.calls[0]?.[1])).toContain("1/1");
  });

  it("does not call onProgress when total is 0", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    // total: 0 means the onProgress guard (total > 0) prevents the call
    const workoutsResponse = makeWorkoutApiResponse([sampleWahooWorkoutNoFit], { total: 0 });
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        return Promise.resolve(Response.json(workoutsResponse));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const onProgress = vi.fn();
    const provider = new WahooProvider(mockFetch);
    await provider.sync(mockDb, new Date("2026-01-01T00:00:00Z"), { onProgress });

    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe("WahooProvider.sync — FIT file download error", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("collects FIT download errors but still counts the activity as synced", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    // Workout has a fitFileUrl
    const workoutsResponse = makeWorkoutApiResponse([sampleWahooWorkout]);
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        return Promise.resolve(Response.json(workoutsResponse));
      }
      // FIT CDN URL returns 404
      if (urlStr.includes("cdn.wahoo.com")) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01T00:00:00Z"));

    // Activity is still synced even though FIT download failed
    expect(result.recordsSynced).toBe(1);
    // FIT error is collected
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("FIT file");
    expect(result.errors[0]?.externalId).toBe("42");
  });
});

describe("WahooProvider.sync — activity insert error", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("collects DB insert errors for individual workouts and continues", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const insertError = new Error("DB constraint violated");

    // insert throws for activity but tokens use insert with onConflictDoUpdate
    // We need to distinguish token save from activity insert.
    // Tokens are saved via saveTokens which does insert().values().onConflictDoUpdate()
    // Activity insert also uses insert().values().onConflictDoUpdate()
    // Since tokens are only saved when refreshing (not needed here with valid tokens),
    // any insert call here is for the activity — make it throw.
    const mockInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation(() => {
        throw insertError;
      }),
    });

    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const workoutsResponse = makeWorkoutApiResponse([sampleWahooWorkoutNoFit]);
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        return Promise.resolve(Response.json(workoutsResponse));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01T00:00:00Z"));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("DB constraint violated");
  });
});

describe("WahooProvider.sync — multi-page pagination", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("fetches multiple pages when hasMore is true on first page", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const page1Workout: WahooWorkout = {
      ...sampleWahooWorkoutNoFit,
      id: 100,
      starts: "2026-03-02T18:00:00.000Z",
    };
    const page2Workout: WahooWorkout = {
      ...sampleWahooWorkoutNoFit,
      id: 101,
      starts: "2026-03-01T18:00:00.000Z",
    };

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        callCount++;
        if (callCount === 1) {
          // First page: 30 per page, total 31 → hasMore = true (page 1 * 30 < 31)
          return Promise.resolve(
            Response.json(
              makeWorkoutApiResponse([page1Workout], { page: 1, total: 31, perPage: 30 }),
            ),
          );
        }
        // Second page: only 1 workout, total 31, page 2 → page*perPage = 60 >= 31 → hasMore = false
        return Promise.resolve(
          Response.json(
            makeWorkoutApiResponse([page2Workout], { page: 2, total: 31, perPage: 30 }),
          ),
        );
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01T00:00:00Z"));

    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    const workoutFetchCalls = mockFetch.mock.calls.filter(([url]) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      return urlStr.includes("/v1/workouts");
    });
    expect(workoutFetchCalls).toHaveLength(2);
  });
});

describe("WahooProvider.sync — result shape", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("always returns provider id 'wahoo' in the result", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: makeInsertMock(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const workoutsResponse = makeWorkoutApiResponse([]);
    const mockFetch = vi.fn().mockResolvedValue(Response.json(workoutsResponse));

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01T00:00:00Z"));

    expect(result.provider).toBe("wahoo");
    expect(typeof result.duration).toBe("number");
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("includes duration in result", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: makeInsertMock(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const workoutsResponse = makeWorkoutApiResponse([]);
    const mockFetch = vi.fn().mockResolvedValue(Response.json(workoutsResponse));

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01T00:00:00Z"));

    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});

describe("parseWorkoutSummary — unknown type", () => {
  it("returns other for unknown workout_type_id", () => {
    const workout: WahooWorkout = {
      id: 999,
      workout_type_id: 99,
      starts: "2026-03-01T10:00:00Z",
      created_at: "2026-03-01T10:00:00Z",
      updated_at: "2026-03-01T10:00:00Z",
    };
    const result = parseWorkoutSummary(workout);
    expect(result.activityType).toBe("other");
  });

  it("maps walking type (8)", () => {
    const workout: WahooWorkout = {
      id: 888,
      workout_type_id: 8,
      starts: "2026-03-01T10:00:00Z",
      created_at: "2026-03-01T10:00:00Z",
      updated_at: "2026-03-01T10:00:00Z",
    };
    expect(parseWorkoutSummary(workout).activityType).toBe("walking");
  });

  it("maps treadmill running type (2)", () => {
    const workout: WahooWorkout = {
      id: 222,
      workout_type_id: 2,
      starts: "2026-03-01T10:00:00Z",
      created_at: "2026-03-01T10:00:00Z",
      updated_at: "2026-03-01T10:00:00Z",
    };
    expect(parseWorkoutSummary(workout).activityType).toBe("running");
  });

  it("sets endedAt to undefined when no duration", () => {
    const workout: WahooWorkout = {
      id: 111,
      workout_type_id: 0,
      starts: "2026-03-01T10:00:00Z",
      created_at: "2026-03-01T10:00:00Z",
      updated_at: "2026-03-01T10:00:00Z",
    };
    const result = parseWorkoutSummary(workout);
    expect(result.endedAt).toBeUndefined();
    expect(result.fitFileUrl).toBeUndefined();
  });
});
