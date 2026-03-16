import { afterEach, describe, expect, it, vi } from "vitest";
import { mapStravaActivityType, StravaClient, StravaProvider } from "../strava.ts";

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

    const client = new StravaClient("test-token", mockFetch);
    const result = await client.getActivities(1000, 2, 50);

    expect(mockFetch).toHaveBeenCalledOnce();
    const callUrl = String(mockFetch.mock.calls[0]?.[0]);
    expect(callUrl).toContain("/athlete/activities");
    expect(callUrl).toContain("after=1000");
    expect(callUrl).toContain("page=2");
    expect(callUrl).toContain("per_page=50");
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
      ]),
    );

    const client = new StravaClient("test-token", mockFetch);
    const streams = await client.getActivityStreams(12345);

    expect(streams.time?.data).toEqual([0, 1, 2]);
    expect(streams.heartrate?.data).toEqual([130, 132, 135]);
    expect(streams.watts?.data).toEqual([200, 210, 205]);
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
    const provider = new StravaProvider(mockFetch);

    // Mock db with loadTokens returning null
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };

    // @ts-expect-error mock DB
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

    const provider = new StravaProvider(mockFetch);

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
    };

    // @ts-expect-error mock DB
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.provider).toBe("strava");
    expect(result.errors.some((e) => e.message.includes("rate limit"))).toBe(true);
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
