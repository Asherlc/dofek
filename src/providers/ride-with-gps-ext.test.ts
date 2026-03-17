import { afterEach, describe, expect, it } from "vitest";
import {
  mapActivityType,
  parseTrackPoints,
  parseTripToActivity,
  RideWithGpsClient,
  RideWithGpsProvider,
  type RideWithGpsTrackPoint,
  type RideWithGpsTripSummary,
  rideWithGpsOAuthConfig,
} from "./ride-with-gps.ts";

// ============================================================
// Extended Ride with GPS tests covering:
// - RideWithGpsClient API calls and error handling
// - rideWithGpsOAuthConfig with/without env vars
// - RideWithGpsProvider validate/authSetup
// - parseTripToActivity with zero duration
// - parseTrackPoints with speed = 0
// ============================================================

describe("RideWithGpsClient — API calls", () => {
  it("sync sends correct URL with since parameter", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedUrl = input.toString();
      capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {}));
      return Response.json({
        items: [],
        meta: { rwgps_datetime: "2026-03-15T12:00:00Z" },
      });
    };

    const client = new RideWithGpsClient("test-token", mockFetch);
    const result = await client.sync("2026-03-01T00:00:00Z");

    expect(capturedUrl).toContain("/api/v1/sync.json");
    expect(capturedUrl).toContain("since=2026-03-01T00");
    expect(capturedUrl).toContain("assets=trips");
    expect(capturedHeaders.Authorization).toBe("Bearer test-token");
    expect(result.items).toHaveLength(0);
    expect(result.meta.rwgps_datetime).toBe("2026-03-15T12:00:00Z");
  });

  it("getTrip sends correct URL with trip ID", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return Response.json({
        trip: {
          id: 42,
          name: "Test Ride",
          distance: 50000,
          duration: 7200,
          moving_time: 6800,
          elevation_gain: 500,
          elevation_loss: 500,
          created_at: "2026-03-15T10:00:00Z",
          updated_at: "2026-03-15T10:00:00Z",
          track_points: [],
        },
      });
    };

    const client = new RideWithGpsClient("test-token", mockFetch);
    const result = await client.getTrip(42);

    expect(capturedUrl).toContain("/api/v1/trips/42.json");
    expect(result.trip.id).toBe(42);
    expect(result.trip.name).toBe("Test Ride");
  });

  it("throws on non-OK response", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new RideWithGpsClient("bad-token", mockFetch);
    await expect(client.sync("2026-03-01")).rejects.toThrow("RWGPS API error (401)");
  });

  it("includes error body in error message", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return new Response("Invalid token", { status: 403 });
    };

    const client = new RideWithGpsClient("bad-token", mockFetch);
    await expect(client.getTrip(123)).rejects.toThrow("Invalid token");
  });
});

describe("rideWithGpsOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when RWGPS_CLIENT_ID is not set", () => {
    delete process.env.RWGPS_CLIENT_ID;
    expect(rideWithGpsOAuthConfig()).toBeNull();
  });

  it("returns config when RWGPS_CLIENT_ID is set", () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";
    const config = rideWithGpsOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("user");
    expect(config?.tokenAuthMethod).toBeUndefined();
    expect(config?.authorizeUrl).toContain("ridewithgps.com");
    expect(config?.tokenUrl).toContain("ridewithgps.com");
  });

  it("returns config without clientSecret when not set", () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    delete process.env.RWGPS_CLIENT_SECRET;
    const config = rideWithGpsOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientSecret).toBeUndefined();
  });
});

describe("RideWithGpsProvider — validate and properties", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("has correct id and name", () => {
    const provider = new RideWithGpsProvider();
    expect(provider.id).toBe("ride-with-gps");
    expect(provider.name).toBe("RideWithGPS");
  });

  it("returns error when RWGPS_CLIENT_ID is not set", () => {
    delete process.env.RWGPS_CLIENT_ID;
    const provider = new RideWithGpsProvider();
    expect(provider.validate()).toContain("RWGPS_CLIENT_ID");
  });

  it("returns null when RWGPS_CLIENT_ID is set", () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const provider = new RideWithGpsProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("RideWithGpsProvider — authSetup", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with correct config", () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";
    const provider = new RideWithGpsProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("ridewithgps.com");
    expect(setup.getUserIdentity).toBeTypeOf("function");
  });

  it("throws when RWGPS_CLIENT_ID is not set", () => {
    delete process.env.RWGPS_CLIENT_ID;
    const provider = new RideWithGpsProvider();
    expect(() => provider.authSetup()).toThrow("RWGPS_CLIENT_ID");
  });
});

describe("parseTripToActivity — additional edge cases", () => {
  it("handles zero duration (endedAt is undefined)", () => {
    const trip: RideWithGpsTripSummary = {
      id: 999,
      name: "Quick Stop",
      departed_at: "2026-03-15T10:00:00Z",
      activity_type: "cycling",
      distance: 0,
      duration: 0,
      moving_time: 0,
      elevation_gain: 0,
      elevation_loss: 0,
      created_at: "2026-03-15T10:00:00Z",
      updated_at: "2026-03-15T10:00:00Z",
    };

    const result = parseTripToActivity(trip);
    expect(result.endedAt).toBeUndefined();
  });

  it("maps cyclocross to cycling", () => {
    expect(mapActivityType("cyclocross")).toBe("cycling");
  });

  it("maps track_cycling to cycling", () => {
    expect(mapActivityType("track_cycling")).toBe("cycling");
  });
});

describe("parseTrackPoints — speed edge cases", () => {
  it("converts speed = 0 to 0 m/s", () => {
    const points: RideWithGpsTrackPoint[] = [{ x: -122.6, y: 45.5, d: 0, t: 1723276200, s: 0 }];
    const result = parseTrackPoints(points);
    expect(result[0]?.speed).toBeCloseTo(0);
  });

  it("handles undefined speed as undefined", () => {
    const points: RideWithGpsTrackPoint[] = [{ x: -122.6, y: 45.5, d: 0, t: 1723276200 }];
    const result = parseTrackPoints(points);
    expect(result[0]?.speed).toBeUndefined();
  });
});
