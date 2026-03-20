import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import { mapStravaActivityType, StravaClient, StravaProvider } from "./strava.ts";

// ============================================================
// Tests targeting uncovered sync paths in strava.ts
// ============================================================

describe("StravaClient", () => {
  it("getActivities makes correct API call", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json([
        {
          id: 1,
          name: "Ride",
          type: "Ride",
          sport_type: "Ride",
          start_date: "2026-03-01T08:00:00Z",
          elapsed_time: 3600,
          moving_time: 3500,
          distance: 30000,
          total_elevation_gain: 200,
          trainer: false,
          commute: false,
          manual: false,
        },
      ]),
    );

    const client = new StravaClient("test-token", mockFetch, 0);
    const result = await client.getActivities(1000, 2, 50);

    expect(mockFetch).toHaveBeenCalledOnce();
    const callUrl = String(mockFetch.mock.calls[0]?.[0]);
    const callOptions = mockFetch.mock.calls[0]?.[1];
    const headers = getRequestHeaders(callOptions);
    expect(callUrl).toContain("/athlete/activities");
    expect(callUrl).toContain("after=1000");
    expect(callUrl).toContain("page=2");
    expect(callUrl).toContain("per_page=50");
    expect(headers).toEqual(expect.objectContaining({ Authorization: "Bearer test-token" }));
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(1);
  });

  it("getActivityStreams transforms array to keyed object", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json([
        {
          type: "time",
          data: [0, 1, 2],
          series_type: "time",
          resolution: "high",
          original_size: 3,
        },
        {
          type: "heartrate",
          data: [130, 132, 135],
          series_type: "time",
          resolution: "high",
          original_size: 3,
        },
        {
          type: "watts",
          data: [200, 210, 205],
          series_type: "time",
          resolution: "high",
          original_size: 3,
        },
        {
          type: "mystery_stream",
          data: [1, 2, 3],
          series_type: "time",
          resolution: "high",
          original_size: 3,
        },
      ]),
    );

    const client = new StravaClient("test-token", mockFetch, 0);
    const streams = await client.getActivityStreams(12345);

    const calledUrl = String(mockFetch.mock.calls[0]?.[0]);
    const url = new URL(calledUrl);
    expect(url.searchParams.get("keys")).toBe(
      "time,heartrate,watts,cadence,velocity_smooth,latlng,altitude,distance,temp,grade_smooth",
    );
    expect(url.searchParams.get("key_type")).toBe("time");
    expect(streams.time?.data).toEqual([0, 1, 2]);
    expect(streams.heartrate?.data).toEqual([130, 132, 135]);
    expect(streams.watts?.data).toEqual([200, 210, 205]);
    expect("mystery_stream" in streams).toBe(false);
  });
});

describe("StravaProvider.sync", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when tokens cannot be loaded", async () => {
    process.env.STRAVA_CLIENT_ID = "id";
    process.env.STRAVA_CLIENT_SECRET = "secret";

    const mockFetch = vi.fn();
    const provider = new StravaProvider(mockFetch, 0);

    // Mock db with loadTokens returning null
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
    expect(result.provider).toBe("strava");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
  });

  it("handles rate limit during activity fetch", async () => {
    process.env.STRAVA_CLIENT_ID = "id";
    process.env.STRAVA_CLIENT_SECRET = "secret";

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      // Token load
      if (callCount === 0 && url.includes("/athlete/activities")) {
        callCount++;
        return new Response("Rate limited", { status: 429 });
      }
      return Response.json([]);
    });

    const provider = new StravaProvider(mockFetch, 0);

    // Provide tokens
    const futureDate = new Date("2099-01-01");
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                providerId: "strava",
                accessToken: "token",
                refreshToken: "refresh",
                expiresAt: futureDate,
                scopes: null,
              },
            ]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "act-1" }]),
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.provider).toBe("strava");
    expect(result.errors.some((e) => e.message.includes("rate limit"))).toBe(true);
  });
});

// ============================================================
// Helper factories shared by the sync integration tests below
// ============================================================

const FUTURE_DATE = new Date("2099-01-01");

const VALID_TOKEN = {
  providerId: "strava",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: FUTURE_DATE,
  scopes: null,
};

const EXPIRED_TOKEN = {
  ...VALID_TOKEN,
  accessToken: "old-access-token",
  refreshToken: "refresh-token",
  expiresAt: new Date("2000-01-01"),
};

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function getRequestHeaders(value: unknown): HeadersInit | undefined {
  if (typeof value !== "object" || value === null || !("headers" in value)) return undefined;
  const headers = Reflect.get(value, "headers");
  if (Array.isArray(headers)) return headers;
  if (headers instanceof Headers) return headers;
  if (isStringRecord(headers)) return headers;
  return undefined;
}

function getProviderId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("providerId" in value)) return undefined;
  const providerId = Reflect.get(value, "providerId");
  return typeof providerId === "string" ? providerId : undefined;
}

function getSetSourceName(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("set" in value)) return undefined;
  const set = Reflect.get(value, "set");
  if (typeof set !== "object" || set === null || !("sourceName" in set)) return undefined;
  return Reflect.get(set, "sourceName");
}

function createMockDb(tokenRows = [VALID_TOKEN]): SyncDatabase {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(tokenRows),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation(() => {
        return Object.assign(Promise.resolve(), {
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "act-uuid" }]),
          }),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        });
      }),
    }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    execute: vi.fn().mockResolvedValue([]),
  };
}

const MOCK_ACTIVITY = {
  id: 12345678,
  name: "Morning Ride",
  type: "Ride",
  sport_type: "Ride",
  start_date: "2026-03-01T08:00:00Z",
  elapsed_time: 3600,
  moving_time: 3500,
  distance: 30000,
  total_elevation_gain: 200,
  trainer: false,
  commute: false,
  manual: false,
};

const MOCK_STREAMS = [
  { type: "time", data: [0, 1, 2], series_type: "time", resolution: "high", original_size: 3 },
  {
    type: "heartrate",
    data: [130, 132, 135],
    series_type: "time",
    resolution: "high",
    original_size: 3,
  },
];

describe("StravaProvider.sync — additional coverage", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  function setupEnv() {
    process.env.STRAVA_CLIENT_ID = "test-client-id";
    process.env.STRAVA_CLIENT_SECRET = "test-client-secret";
  }

  it("happy path: fetches activities, inserts into DB, returns recordsSynced >= 1", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}/streams`)) {
        return Promise.resolve(Response.json(MOCK_STREAMS));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json({ ...MOCK_ACTIVITY, device_name: "Wahoo ELEMNT" }));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch, 0);

    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    expect(result.provider).toBe("strava");
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);
    expect(result.errors).toHaveLength(0);
    expect(
      mockFetch.mock.calls.some(([url]) =>
        String(url).includes(`/activities/${MOCK_ACTIVITY.id}/streams`),
      ),
    ).toBe(true);
  });

  it("writes expected upsert payloads for activity records", async () => {
    setupEnv();

    const secondActivity = {
      ...MOCK_ACTIVITY,
      id: 87654321,
      name: "Evening Ride",
    };

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY, secondActivity]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}/streams`)) {
        return Promise.resolve(Response.json(MOCK_STREAMS));
      }
      if (urlStr.includes(`/activities/${secondActivity.id}/streams`)) {
        return Promise.resolve(Response.json(MOCK_STREAMS));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json({ ...MOCK_ACTIVITY, device_name: "Garmin Edge" }));
      }
      if (urlStr.includes(`/activities/${secondActivity.id}`)) {
        return Promise.resolve(Response.json({ ...secondActivity, device_name: "Garmin Edge" }));
      }
      return Promise.resolve(Response.json([]));
    });

    const activityInsertPayloads: unknown[] = [];
    const upsertConfigs: unknown[] = [];
    const insertValuesMock = vi.fn().mockImplementation((payload: unknown) => {
      if (Array.isArray(payload)) return Promise.resolve();
      if (getProviderId(payload) === "strava") {
        activityInsertPayloads.push(payload);
      }
      return {
        onConflictDoUpdate: vi.fn().mockImplementation((config: unknown) => {
          upsertConfigs.push(config);
          return {
            returning: vi.fn().mockResolvedValue([{ id: "activity-row-id" }]),
          };
        }),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      };
    });

    const mockDb: SyncDatabase = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([VALID_TOKEN]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: insertValuesMock,
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new StravaProvider(mockFetch, 0);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    expect(result.errors).toHaveLength(0);
    expect(activityInsertPayloads).toHaveLength(2);
    expect(activityInsertPayloads[0]).toMatchObject({
      providerId: "strava",
      externalId: String(MOCK_ACTIVITY.id),
      raw: { id: MOCK_ACTIVITY.id },
    });
    expect(activityInsertPayloads[1]).toMatchObject({
      providerId: "strava",
      externalId: String(secondActivity.id),
      raw: { id: secondActivity.id },
    });
    expect(upsertConfigs).toHaveLength(2);
    expect(upsertConfigs[0]).toMatchObject({
      target: expect.arrayContaining([expect.anything(), expect.anything()]),
      set: expect.objectContaining({
        raw: expect.objectContaining({ id: MOCK_ACTIVITY.id }),
      }),
    });
    expect(upsertConfigs[1]).toMatchObject({
      target: expect.arrayContaining([expect.anything(), expect.anything()]),
      set: expect.objectContaining({
        raw: expect.objectContaining({ id: secondActivity.id }),
      }),
    });
    const firstSetSourceName = getSetSourceName(upsertConfigs[0]);
    expect(firstSetSourceName).toBeDefined();
  });

  it("converts since date to epoch seconds using division by 1000", async () => {
    setupEnv();

    const sinceDate = new Date("2026-03-01T00:00:00Z");
    const expectedEpoch = Math.floor(sinceDate.getTime() / 1000);

    let capturedUrl = "";
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        capturedUrl = urlStr;
        return Promise.resolve(Response.json([]));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch, 0);

    await provider.sync(mockDb, sinceDate);

    expect(capturedUrl).toContain(`after=${expectedEpoch}`);
    // Explicitly confirm the value is in seconds, not milliseconds
    expect(capturedUrl).not.toContain(`after=${sinceDate.getTime()}`);
  });

  it("since epoch value is clearly seconds-based (not milliseconds)", async () => {
    setupEnv();

    const sinceDate = new Date("2026-03-01T00:00:00Z");
    const epochSeconds = Math.floor(sinceDate.getTime() / 1000);
    const epochMilliseconds = sinceDate.getTime();

    let capturedUrl = "";
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        capturedUrl = urlStr;
        return Promise.resolve(Response.json([]));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch, 0);

    await provider.sync(mockDb, sinceDate);

    const urlParams = new URL(capturedUrl).searchParams;
    const afterParam = Number(urlParams.get("after"));

    expect(afterParam).toBe(epochSeconds);
    // Division by 1000 produces a ~10-digit value; multiplication would give ~13 digits
    expect(afterParam).toBeLessThan(epochMilliseconds);
    expect(afterParam).toBeGreaterThan(0);
  });

  it("stops pagination when activities page has fewer than perPage items", async () => {
    setupEnv();

    let activitiesCallCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        activitiesCallCount++;
        // Return only 1 activity (< perPage of 30) → hasMore should be false
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}/streams`)) {
        return Promise.resolve(Response.json(MOCK_STREAMS));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch, 0);

    await provider.sync(mockDb, new Date("2026-01-01"));

    // Should only call getActivities once since result < perPage
    expect(activitiesCallCount).toBe(1);
  });

  it("continues pagination when a full page of activities is returned", async () => {
    setupEnv();

    const fullPage = Array.from({ length: 30 }, (_, i) => ({ ...MOCK_ACTIVITY, id: i + 1 }));
    let activitiesCallCount = 0;

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        activitiesCallCount++;
        // First page: full 30 activities; second page: empty → stop
        return Promise.resolve(Response.json(activitiesCallCount === 1 ? fullPage : []));
      }
      if (urlStr.includes("/streams")) {
        return Promise.resolve(Response.json(MOCK_STREAMS));
      }
      // Detail fetches for each activity
      return Promise.resolve(Response.json({ ...MOCK_ACTIVITY }));
    });

    // Need a db mock that returns a UUID for every insert
    const mockDb: SyncDatabase = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([VALID_TOKEN]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation(() => {
          return Object.assign(Promise.resolve(), {
            onConflictDoUpdate: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: `act-uuid-${Math.random()}` }]),
            }),
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          });
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new StravaProvider(mockFetch, 0);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    expect(activitiesCallCount).toBe(2);
    expect(result.recordsSynced).toBe(30);
    const activityPages = mockFetch.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/athlete/activities"))
      .map((url) => Number(new URL(url).searchParams.get("page")));
    expect(activityPages).toEqual([1, 2]);
  });

  it("invokes onProgress callback with synced activity count message", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes("/streams")) {
        return Promise.resolve(Response.json(MOCK_STREAMS));
      }
      return Promise.resolve(Response.json(MOCK_ACTIVITY));
    });

    const mockDb = createMockDb();
    const onProgress = vi.fn();
    const provider = new StravaProvider(mockFetch, 0);

    await provider.sync(mockDb, new Date("2026-01-01"), onProgress);

    expect(onProgress).toHaveBeenCalledWith(0, "1 activities synced");
  });

  it("rate limit on activity detail fetch: sets rateLimited, adds error, returns gracefully", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`) && !urlStr.includes("/streams")) {
        return Promise.resolve(new Response("Rate limited", { status: 429 }));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch, 0);

    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    expect(result.provider).toBe("strava");
    expect(result.errors.some((e) => e.message.includes("rate limit"))).toBe(true);
    // Should not throw — graceful return
    expect(result.errors.some((e) => e.message.toLowerCase().includes("detail"))).toBe(true);
  });

  it("rate limit on streams fetch: adds error but still counts activity as synced", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes("/streams")) {
        return Promise.resolve(new Response("Rate limited", { status: 429 }));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch, 0);

    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    // Activity insert happened before streams, so recordsSynced should be 1
    expect(result.recordsSynced).toBe(1);
    expect(result.errors.some((e) => e.message.includes("rate limit"))).toBe(true);
  });

  it("duration in result is positive (Date.now() - start, not + start)", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/athlete/activities")) {
        return Promise.resolve(Response.json([]));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch, 0);

    const before = Date.now();
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    const after = Date.now();

    expect(result.duration).toBeGreaterThanOrEqual(0);
    // If the mutation changed - to +, duration would be ~2x Date.now() (order of 10^12)
    expect(result.duration).toBeLessThanOrEqual(after - before + 100);
  });

  it("token refresh: calls fetch for token endpoint when token is expired", async () => {
    setupEnv();

    const refreshedToken = {
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: FUTURE_DATE,
    };

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("strava.com/oauth/token")) {
        return Promise.resolve(
          Response.json({
            access_token: refreshedToken.accessToken,
            refresh_token: refreshedToken.refreshToken,
            expires_at: Math.floor(FUTURE_DATE.getTime() / 1000),
            token_type: "Bearer",
          }),
        );
      }
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([]));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb([EXPIRED_TOKEN]);
    const provider = new StravaProvider(mockFetch, 0);

    await provider.sync(mockDb, new Date("2026-01-01"));

    const oauthCall = mockFetch.mock.calls.find(([url]) =>
      String(url).includes("strava.com/oauth/token"),
    );
    expect(oauthCall).toBeDefined();
  });

  it("does not call OAuth token refresh when access token is still valid", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([]));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb([VALID_TOKEN]);
    const provider = new StravaProvider(mockFetch, 0);

    await provider.sync(mockDb, new Date("2026-01-01"));

    const oauthCall = mockFetch.mock.calls.find(([url]) =>
      String(url).includes("strava.com/oauth/token"),
    );
    expect(oauthCall).toBeUndefined();
  });

  it("hasMore is false when rateLimited is true even if page was full", async () => {
    setupEnv();

    // Full page of activities, but streams trigger rate limit on first one
    const fullPage = Array.from({ length: 30 }, (_, i) => ({ ...MOCK_ACTIVITY, id: i + 1 }));
    let activitiesCallCount = 0;

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        activitiesCallCount++;
        return Promise.resolve(Response.json(fullPage));
      }
      if (urlStr.includes("/streams")) {
        return Promise.resolve(new Response("Rate limited", { status: 429 }));
      }
      return Promise.resolve(Response.json({ ...MOCK_ACTIVITY }));
    });

    const mockDb: SyncDatabase = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([VALID_TOKEN]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation(() => {
          return Object.assign(Promise.resolve(), {
            onConflictDoUpdate: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: `act-uuid-${Math.random()}` }]),
            }),
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          });
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new StravaProvider(mockFetch, 0);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    // rateLimited breaks out of inner loop and sets hasMore = false
    // so getActivities should only be called once
    expect(activitiesCallCount).toBe(1);
    expect(result.errors.some((e) => e.message.includes("rate limit"))).toBe(true);
  });

  it("authorization error from getActivities is captured and returned in sync result", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/athlete/activities")) {
        return Promise.resolve(
          new Response(JSON.stringify({ message: "Authorization Error" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch, 0);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("run: health-data auth strava");
  });

  it("generic getActivities failures are returned as fetch errors", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/athlete/activities")) {
        return Promise.resolve(new Response("Server Error", { status: 500 }));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch, 0);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Strava activities fetch failed");
  });

  it("skips stream fetch when activity upsert does not return an id", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`) && !urlStr.includes("/streams")) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    const returningMock = vi.fn().mockResolvedValue([]);
    const insertValuesMock = vi.fn().mockImplementation((payload: unknown) => {
      if (Array.isArray(payload)) return Promise.resolve();
      return {
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: returningMock,
        }),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      };
    });

    const mockDb: SyncDatabase = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([VALID_TOKEN]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: insertValuesMock,
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new StravaProvider(mockFetch, 0);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    expect(returningMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.anything(),
      }),
    );
    expect(
      mockFetch.mock.calls.some(([url]) =>
        String(url).includes(`/activities/${MOCK_ACTIVITY.id}/streams`),
      ),
    ).toBe(false);
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("activity with no streams (empty streams response) still increments recordsSynced", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes("/streams")) {
        // Empty streams array → no metric rows inserted
        return Promise.resolve(Response.json([]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch, 0);

    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("does not insert metric rows when streams are empty", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}/streams`)) {
        return Promise.resolve(Response.json([]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    const metricBatchSizes: number[] = [];
    const insertValuesMock = vi.fn().mockImplementation((payload: unknown) => {
      if (Array.isArray(payload)) {
        metricBatchSizes.push(payload.length);
        return Promise.resolve();
      }
      return {
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "activity-row-id" }]),
        }),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      };
    });

    const mockDb: SyncDatabase = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([VALID_TOKEN]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: insertValuesMock,
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new StravaProvider(mockFetch, 0);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    expect(result.recordsSynced).toBe(1);
    expect(metricBatchSizes).toEqual([]);
    expect(result.errors).toHaveLength(0);
  });

  it("inserts metric rows in 500-record batches", async () => {
    setupEnv();

    const rowCount = 1001;
    const largeStreams = [
      {
        type: "time",
        data: Array.from({ length: rowCount }, (_, i) => i),
        series_type: "time",
        resolution: "high",
        original_size: rowCount,
      },
      {
        type: "heartrate",
        data: Array.from({ length: rowCount }, () => 140),
        series_type: "time",
        resolution: "high",
        original_size: rowCount,
      },
    ];

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}/streams`)) {
        return Promise.resolve(Response.json(largeStreams));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    const metricBatchSizes: number[] = [];
    const insertValuesMock = vi.fn().mockImplementation((payload: unknown) => {
      if (Array.isArray(payload)) {
        metricBatchSizes.push(payload.length);
        return Promise.resolve();
      }
      return {
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "activity-row-id" }]),
        }),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      };
    });

    const mockDb: SyncDatabase = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([VALID_TOKEN]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: insertValuesMock,
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new StravaProvider(mockFetch, 0);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    expect(result.recordsSynced).toBe(1);
    expect(metricBatchSizes).toEqual([500, 500, 1]);
    expect(result.errors).toHaveLength(0);
  });

  it("authorization error while fetching streams is returned with auth guidance", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes("/streams")) {
        return Promise.resolve(new Response("Unauthorized", { status: 401 }));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch, 0);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("authorization failed while fetching streams");
  });

  it("404 while fetching streams is treated as missing streams, not an error", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes("/streams")) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch, 0);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("non-rate-limit stream error is recorded but does not stop processing", async () => {
    setupEnv();

    const secondActivity = { ...MOCK_ACTIVITY, id: 99999999 };
    let streamCallCount = 0;

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY, secondActivity]));
      }
      if (urlStr.includes("/streams")) {
        streamCallCount++;
        if (streamCallCount === 1) {
          // First streams call returns server error (non-rate-limit)
          return Promise.resolve(
            new Response(JSON.stringify({ message: "Server Error" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(Response.json(MOCK_STREAMS));
      }
      return Promise.resolve(Response.json(MOCK_ACTIVITY));
    });

    const mockDb: SyncDatabase = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([VALID_TOKEN]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation(() => {
          return Object.assign(Promise.resolve(), {
            onConflictDoUpdate: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: `act-uuid-${Math.random()}` }]),
            }),
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          });
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new StravaProvider(mockFetch, 0);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    // Both activities should be counted even though first streams call failed
    expect(result.recordsSynced).toBe(2);
    expect(result.errors.some((e) => e.message.includes("Streams for activity"))).toBe(true);
  });
});

describe("mapStravaActivityType — additional types", () => {
  it("maps Canoeing and Kayaking to rowing", () => {
    expect(mapStravaActivityType("Canoeing")).toBe("rowing");
    expect(mapStravaActivityType("Kayaking")).toBe("rowing");
  });

  it("maps BackcountrySki to skiing", () => {
    expect(mapStravaActivityType("BackcountrySki")).toBe("skiing");
  });

  it("maps Snowboard to skiing", () => {
    expect(mapStravaActivityType("Snowboard")).toBe("skiing");
  });

  it("maps IceSkate to skating", () => {
    expect(mapStravaActivityType("IceSkate")).toBe("skating");
  });

  it("maps RollerSki to skiing", () => {
    expect(mapStravaActivityType("RollerSki")).toBe("skiing");
  });

  it("maps Crossfit to strength", () => {
    expect(mapStravaActivityType("Crossfit")).toBe("strength");
  });

  it("maps RockClimbing to climbing", () => {
    expect(mapStravaActivityType("RockClimbing")).toBe("climbing");
  });
});
