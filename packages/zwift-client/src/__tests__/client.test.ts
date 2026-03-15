import { describe, expect, it, vi } from "vitest";
import { ZwiftClient, ZWIFT_API_BASE, ZWIFT_AUTH_URL } from "../client.ts";
import type {
  ZwiftActivityDetail,
  ZwiftActivitySummary,
  ZwiftFitnessData,
  ZwiftPowerCurve,
  ZwiftProfile,
  ZwiftTokenResponse,
} from "../types.ts";

type MockFetchFn = ReturnType<typeof vi.fn>;

function mockFetch(
  response: { status: number; ok: boolean; body: unknown },
): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(typeof response.body === "string" ? response.body : JSON.stringify(response.body)),
  });
}

describe("Zwift constants", () => {
  it("exports ZWIFT_API_BASE as a non-empty string", () => {
    expect(ZWIFT_API_BASE).toBeTruthy();
    expect(ZWIFT_API_BASE).toContain("zwift.com");
  });

  it("exports ZWIFT_AUTH_URL as a non-empty string", () => {
    expect(ZWIFT_AUTH_URL).toBeTruthy();
    expect(ZWIFT_AUTH_URL).toContain("zwift.com");
  });
});

describe("ZwiftClient.signIn", () => {
  it("returns accessToken, refreshToken, and expiresIn on success", async () => {
    const tokenResponse: ZwiftTokenResponse = {
      access_token: "zwift-access-token",
      refresh_token: "zwift-refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
    };

    const fetchFn = mockFetch({ status: 200, ok: true, body: tokenResponse });

    const result = await ZwiftClient.signIn("rider@example.com", "password123", fetchFn);

    expect(result).toEqual({
      accessToken: "zwift-access-token",
      refreshToken: "zwift-refresh-token",
      expiresIn: 3600,
    });

    const [url, options] = (fetchFn as MockFetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ZWIFT_AUTH_URL);
    expect(options.method).toBe("POST");
    const body = new URLSearchParams(options.body as string);
    expect(body.get("client_id")).toBe("Zwift Game Client");
    expect(body.get("grant_type")).toBe("password");
    expect(body.get("username")).toBe("rider@example.com");
    expect(body.get("password")).toBe("password123");
  });

  it("throws on non-200 response", async () => {
    const fetchFn = mockFetch({ status: 401, ok: false, body: "Invalid credentials" });

    await expect(
      ZwiftClient.signIn("rider@example.com", "wrong-password", fetchFn),
    ).rejects.toThrow("Zwift sign-in failed (401)");
  });
});

describe("ZwiftClient.refreshToken", () => {
  it("returns new tokens on success", async () => {
    const tokenResponse: ZwiftTokenResponse = {
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
    };

    const fetchFn = mockFetch({ status: 200, ok: true, body: tokenResponse });

    const result = await ZwiftClient.refreshToken("old-refresh-token", fetchFn);

    expect(result).toEqual({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 3600,
    });

    const [url, options] = (fetchFn as MockFetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ZWIFT_AUTH_URL);
    const body = new URLSearchParams(options.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh-token");
  });

  it("throws on non-200 response", async () => {
    const fetchFn = mockFetch({ status: 400, ok: false, body: "Invalid refresh token" });

    await expect(
      ZwiftClient.refreshToken("expired-token", fetchFn),
    ).rejects.toThrow("Zwift token refresh failed (400)");
  });
});

describe("ZwiftClient.getActivities", () => {
  it("returns activities on success", async () => {
    const activities: ZwiftActivitySummary[] = [
      {
        id: 1,
        id_str: "1",
        profileId: 100,
        name: "Morning Ride",
        startDate: "2024-01-15T08:00:00Z",
        endDate: "2024-01-15T09:30:00Z",
        distanceInMeters: 42000,
        avgHeartRate: 145,
        maxHeartRate: 175,
        avgWatts: 200,
        maxWatts: 350,
        avgCadenceInRotationsPerMinute: 90,
        avgSpeedInMetersPerSecond: 7.8,
        maxSpeedInMetersPerSecond: 12.5,
        totalElevationInMeters: 500,
        calories: 900,
        sport: "CYCLING",
        rideOnGiven: 5,
        activityRideOnCount: 10,
      },
    ];

    const fetchFn = mockFetch({ status: 200, ok: true, body: activities });
    const client = new ZwiftClient("test-token", 100, fetchFn);

    const result = await client.getActivities(0, 10);

    expect(result).toEqual(activities);
    const [url] = (fetchFn as MockFetchFn).mock.calls[0] as [string];
    expect(url).toContain("/api/profiles/100/activities");
    expect(url).toContain("start=0");
    expect(url).toContain("limit=10");
  });

  it("uses default start and limit", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: [] });
    const client = new ZwiftClient("test-token", 100, fetchFn);

    await client.getActivities();

    const [url] = (fetchFn as MockFetchFn).mock.calls[0] as [string];
    expect(url).toContain("start=0");
    expect(url).toContain("limit=20");
  });

  it("throws on non-200 response", async () => {
    const fetchFn = mockFetch({ status: 500, ok: false, body: "Server Error" });
    const client = new ZwiftClient("test-token", 100, fetchFn);

    await expect(client.getActivities()).rejects.toThrow("Zwift API error (500)");
  });
});

describe("ZwiftClient.getActivityDetail", () => {
  it("returns activity detail on success", async () => {
    const detail: ZwiftActivityDetail = {
      id: 1,
      id_str: "1",
      profileId: 100,
      name: "Morning Ride",
      startDate: "2024-01-15T08:00:00Z",
      endDate: "2024-01-15T09:30:00Z",
      distanceInMeters: 42000,
      avgHeartRate: 145,
      maxHeartRate: 175,
      avgWatts: 200,
      maxWatts: 350,
      avgCadenceInRotationsPerMinute: 90,
      avgSpeedInMetersPerSecond: 7.8,
      maxSpeedInMetersPerSecond: 12.5,
      totalElevationInMeters: 500,
      calories: 900,
      sport: "CYCLING",
      fitnessData: { fullDataUrl: "https://example.com/data" },
    };

    const fetchFn = mockFetch({ status: 200, ok: true, body: detail });
    const client = new ZwiftClient("test-token", 100, fetchFn);

    const result = await client.getActivityDetail(1);

    expect(result).toEqual(detail);
    const [url] = (fetchFn as MockFetchFn).mock.calls[0] as [string];
    expect(url).toContain("/api/activities/1");
    expect(url).toContain("fetchSnapshots=true");
  });

  it("throws on non-200 response", async () => {
    const fetchFn = mockFetch({ status: 404, ok: false, body: "Not Found" });
    const client = new ZwiftClient("test-token", 100, fetchFn);

    await expect(client.getActivityDetail(999)).rejects.toThrow("Zwift API error (404)");
  });
});

describe("ZwiftClient.getFitnessData", () => {
  it("returns fitness data on success", async () => {
    const fitnessData: ZwiftFitnessData = {
      powerInWatts: [200, 210, 220],
      heartRate: [140, 145, 150],
      cadencePerMin: [90, 92, 88],
      distanceInCm: [0, 100, 200],
      speedInCmPerSec: [700, 720, 710],
      altitudeInCm: [5000, 5100, 5050],
      timeInSec: [0, 1, 2],
    };

    const fetchFn = mockFetch({ status: 200, ok: true, body: fitnessData });
    const client = new ZwiftClient("test-token", 100, fetchFn);

    const result = await client.getFitnessData("https://example.com/fitness-data");

    expect(result).toEqual(fitnessData);
    const [url, options] = (fetchFn as MockFetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/fitness-data");
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
  });

  it("throws on non-200 response", async () => {
    const fetchFn = mockFetch({ status: 403, ok: false, body: "Forbidden" });
    const client = new ZwiftClient("test-token", 100, fetchFn);

    await expect(
      client.getFitnessData("https://example.com/fitness-data"),
    ).rejects.toThrow("Zwift fitness data fetch failed (403)");
  });
});

describe("ZwiftClient.getPowerCurve", () => {
  it("returns power curve on success", async () => {
    const powerCurve: ZwiftPowerCurve = {
      zFtp: 250,
      zMap: 300,
      vo2Max: 55.0,
      efforts: [
        { duration: 5, watts: 800, timestamp: "2024-01-15T08:30:00Z" },
        { duration: 60, watts: 400, timestamp: "2024-01-15T08:31:00Z" },
        { duration: 300, watts: 280, timestamp: "2024-01-15T08:35:00Z" },
      ],
    };

    const fetchFn = mockFetch({ status: 200, ok: true, body: powerCurve });
    const client = new ZwiftClient("test-token", 100, fetchFn);

    const result = await client.getPowerCurve();

    expect(result).toEqual(powerCurve);
    const [url] = (fetchFn as MockFetchFn).mock.calls[0] as [string];
    expect(url).toContain("/api/power-curve/power-profile");
  });

  it("throws on non-200 response", async () => {
    const fetchFn = mockFetch({ status: 500, ok: false, body: "Server Error" });
    const client = new ZwiftClient("test-token", 100, fetchFn);

    await expect(client.getPowerCurve()).rejects.toThrow("Zwift API error (500)");
  });
});

describe("ZwiftClient.getProfile", () => {
  it("returns profile on success", async () => {
    const profile: ZwiftProfile = {
      id: 100,
      firstName: "Test",
      lastName: "User",
      ftp: 250,
      weight: 72000,
      height: 180,
    };

    const fetchFn = mockFetch({ status: 200, ok: true, body: profile });
    const client = new ZwiftClient("test-token", 100, fetchFn);

    const result = await client.getProfile();

    expect(result).toEqual(profile);
    const [url] = (fetchFn as MockFetchFn).mock.calls[0] as [string];
    expect(url).toContain("/api/profiles/100");
  });
});
