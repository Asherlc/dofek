import { afterEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../db/tokens.ts", () => ({
  loadTokens: vi.fn(),
  saveTokens: vi.fn(),
  ensureProvider: vi.fn(),
}));

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

vi.mock("../auth/oauth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/oauth.ts")>();
  return {
    ...actual,
    exchangeCodeForTokens: vi.fn().mockResolvedValue({
      accessToken: "exchanged-token",
      refreshToken: "exchanged-refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    }),
    refreshAccessToken: vi.fn().mockResolvedValue({
      accessToken: "refreshed-token",
      refreshToken: "new-refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    }),
  };
});

// ============================================================
// Extended Ride with GPS tests covering:
// - RideWithGpsClient API calls and error handling
// - rideWithGpsOAuthConfig with/without env vars
// - RideWithGpsProvider validate/authSetup/getUserIdentity/sync
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

  it("getTrip transforms compact track point keys to descriptive names", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
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
          track_points: [
            {
              x: -122.6,
              y: 45.5,
              d: 0,
              e: 123,
              t: 1742025600,
              s: 25,
              T: 21,
              h: 140,
              c: 90,
              p: 200,
            },
          ],
        },
      });
    };

    const client = new RideWithGpsClient("test-token", mockFetch);
    const result = await client.getTrip(42);
    const point = result.trip.track_points[0];
    expect(point).toEqual({
      longitude: -122.6,
      latitude: 45.5,
      distanceMeters: 0,
      elevationMeters: 123,
      epochSeconds: 1742025600,
      speedKph: 25,
      temperatureCelsius: 21,
      heartRateBpm: 140,
      cadenceRpm: 90,
      powerWatts: 200,
    });
    expect(point).not.toHaveProperty("x");
    expect(point).not.toHaveProperty("y");
    expect(point).not.toHaveProperty("t");
    expect(point).not.toHaveProperty("T");
  });

  it("getTrip tolerates track points with missing x/y/d fields", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return Response.json({
        trip: {
          id: 43,
          name: "Indoor Ride",
          distance: 0,
          duration: 1800,
          moving_time: 1800,
          elevation_gain: 0,
          elevation_loss: 0,
          created_at: "2026-03-15T10:00:00Z",
          updated_at: "2026-03-15T10:00:00Z",
          track_points: [
            { t: 1742025600, h: 140, p: 200 },
            { x: -122.6, y: 45.5, d: 100, t: 1742025610 },
          ],
        },
      });
    };

    const client = new RideWithGpsClient("test-token", mockFetch);
    const result = await client.getTrip(43);
    expect(result.trip.track_points).toHaveLength(2);

    const pointWithoutCoords = result.trip.track_points[0];
    expect(pointWithoutCoords?.longitude).toBeUndefined();
    expect(pointWithoutCoords?.latitude).toBeUndefined();
    expect(pointWithoutCoords?.distanceMeters).toBeUndefined();
    expect(pointWithoutCoords?.heartRateBpm).toBe(140);
    expect(pointWithoutCoords?.powerWatts).toBe(200);

    const pointWithCoords = result.trip.track_points[1];
    expect(pointWithCoords?.longitude).toBe(-122.6);
    expect(pointWithCoords?.latitude).toBe(45.5);
  });

  it("getTrip allows track points with missing x/y/d entirely (Zod optional)", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return Response.json({
        trip: {
          id: 44,
          name: "Stationary Activity",
          created_at: "2026-03-15T10:00:00Z",
          updated_at: "2026-03-15T10:00:00Z",
          track_points: [
            {
              t: 1742025600,
              h: 150,
              // x, y, d are missing
            },
          ],
        },
      });
    };

    const client = new RideWithGpsClient("test-token", mockFetch);
    const result = await client.getTrip(44);
    expect(result.trip.track_points).toHaveLength(1);
    expect(result.trip.track_points[0]?.longitude).toBeUndefined();
    expect(result.trip.track_points[0]?.latitude).toBeUndefined();
    expect(result.trip.track_points[0]?.distanceMeters).toBeUndefined();
    expect(result.trip.track_points[0]?.heartRateBpm).toBe(150);
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

  it("returns null when RWGPS_CLIENT_SECRET is not set", () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    delete process.env.RWGPS_CLIENT_SECRET;
    expect(rideWithGpsOAuthConfig()).toBeNull();
  });

  it("returns config with client secret (confidential client, no PKCE)", () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";
    const config = rideWithGpsOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.usePkce).toBeUndefined();
    expect(config?.scopes).toContain("user");
    expect(config?.authorizeUrl).toContain("ridewithgps.com");
    expect(config?.tokenUrl).toContain("ridewithgps.com");
  });

  it("includes revokeUrl for Doorkeeper token revocation", () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";
    const config = rideWithGpsOAuthConfig();
    expect(config?.revokeUrl).toBe("https://ridewithgps.com/oauth/revoke");
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

  it("returns null when both RWGPS_CLIENT_ID and RWGPS_CLIENT_SECRET are set", () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";
    const provider = new RideWithGpsProvider();
    expect(provider.validate()).toBeNull();
  });

  it("returns error when RWGPS_CLIENT_SECRET is not set", () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    delete process.env.RWGPS_CLIENT_SECRET;
    const provider = new RideWithGpsProvider();
    expect(provider.validate()).toContain("RWGPS_CLIENT_SECRET");
  });
});

describe("RideWithGpsProvider — authSetup", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with client secret (confidential client, no PKCE)", () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";
    const provider = new RideWithGpsProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.oauthConfig.usePkce).toBeUndefined();
    expect(setup.oauthConfig.clientSecret).toBe("test-secret");
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

  it("maps cyclocross to cyclocross", () => {
    expect(mapActivityType("cyclocross")).toBe("cyclocross");
  });

  it("maps track_cycling to track_cycling", () => {
    expect(mapActivityType("track_cycling")).toBe("track_cycling");
  });
});

describe("parseTrackPoints — speed edge cases", () => {
  it("converts speed = 0 to 0 m/s", () => {
    const points: RideWithGpsTrackPoint[] = [
      {
        longitude: -122.6,
        latitude: 45.5,
        distanceMeters: 0,
        epochSeconds: 1723276200,
        speedKph: 0,
      },
    ];
    const result = parseTrackPoints(points);
    expect(result[0]?.speed).toBeCloseTo(0);
  });

  it("handles undefined speed as undefined", () => {
    const points: RideWithGpsTrackPoint[] = [
      { longitude: -122.6, latitude: 45.5, distanceMeters: 0, epochSeconds: 1723276200 },
    ];
    const result = parseTrackPoints(points);
    expect(result[0]?.speed).toBeUndefined();
  });
});

describe("RideWithGpsClient — Content-Type header", () => {
  it("sends Content-Type: application/json on requests", async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch: typeof globalThis.fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {}));
      return Response.json({ items: [], meta: { rwgps_datetime: "2026-01-01T00:00:00Z" } });
    };

    const client = new RideWithGpsClient("tok", mockFetch);
    await client.sync("2026-01-01");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
  });
});

describe("RideWithGpsProvider — constructor stores fetchFn", () => {
  it("uses the injected fetch function for API calls", () => {
    const customFetch = vi.fn().mockResolvedValue(Response.json({}));
    const provider = new RideWithGpsProvider(customFetch);
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";
    const setup = provider.authSetup();
    const getUserIdentity = setup.getUserIdentity;
    expect(getUserIdentity).toBeDefined();
    getUserIdentity?.("tok").catch((_error: unknown) => {});
    expect(customFetch).toHaveBeenCalled();
  });
});

describe("RideWithGpsProvider — exchangeCode calls exchangeCodeForTokens", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("exchangeCode invokes exchangeCodeForTokens with correct args (no PKCE)", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";
    const provider = new RideWithGpsProvider();
    const setup = provider.authSetup();

    const { exchangeCodeForTokens: mockExchange } = await import("../auth/oauth.ts");
    const result = await setup.exchangeCode("auth-code", "verifier");

    // RWGPS is a confidential client — codeVerifier is passed through but PKCE is not enabled
    expect(mockExchange).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "test-id", clientSecret: "test-secret" }),
      "auth-code",
      expect.any(Function),
      { codeVerifier: "verifier" },
    );
    expect(result).toEqual(expect.objectContaining({ accessToken: "exchanged-token" }));
  });

  it("exchangeCode passes undefined options when no codeVerifier", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";
    const provider = new RideWithGpsProvider();
    const setup = provider.authSetup();

    const { exchangeCodeForTokens: mockExchange } = await import("../auth/oauth.ts");
    await setup.exchangeCode("auth-code");

    expect(mockExchange).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "test-id", clientSecret: "test-secret" }),
      "auth-code",
      expect.any(Function),
      undefined,
    );
  });
});

describe("RideWithGpsProvider — getUserIdentity", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns user identity from RWGPS API", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async () => {
      return Response.json({ user: { id: 42, email: "test@example.com", name: "Test User" } });
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const setup = provider.authSetup();
    const getUserIdentity = setup.getUserIdentity;
    expect(getUserIdentity).toBeDefined();
    const identity = await getUserIdentity?.("my-token");

    expect(identity?.providerAccountId).toBe("42");
    expect(identity?.email).toBe("test@example.com");
    expect(identity?.name).toBe("Test User");
  });

  it("handles null email and name", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";
    const mockFetch: typeof globalThis.fetch = async () => {
      return Response.json({ user: { id: 99, email: null, name: null } });
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const setup = provider.authSetup();
    const getUserIdentity = setup.getUserIdentity;
    expect(getUserIdentity).toBeDefined();
    const identity = await getUserIdentity?.("tok");

    expect(identity?.providerAccountId).toBe("99");
    expect(identity?.email).toBeNull();
    expect(identity?.name).toBeNull();
  });

  it("throws on non-OK response", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";
    const mockFetch: typeof globalThis.fetch = async () => {
      return new Response("Forbidden", { status: 403 });
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const setup = provider.authSetup();
    const getUserIdentity = setup.getUserIdentity;
    expect(getUserIdentity).toBeDefined();
    await expect(getUserIdentity?.("bad")).rejects.toThrow("RWGPS user API error (403)");
  });
});

// Chainable Drizzle mock via Proxy — handles any chain of .select().from().where() etc.
// Object.create(null) returns `any` which satisfies SyncDatabase without `as` casts.
function createChainProxy() {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      // Return undefined for 'then' so it's not treated as a thenable
      if (prop === "then") return undefined;
      return (..._args: unknown[]) => new Proxy(Object.create(null), handler);
    },
  };
  return new Proxy(Object.create(null), handler);
}

// Configurable mock DB with select/insert/delete behavior for sync tests
function createSyncMockDb(
  opts: {
    syncCursor?: string | null;
    settingsValue?: unknown;
    activityId?: number;
    returningRows?: Array<{ id?: number }>;
  } = {},
) {
  const selectResult =
    "settingsValue" in opts
      ? [{ value: opts.settingsValue }]
      : opts.syncCursor
        ? [{ value: { cursor: opts.syncCursor } }]
        : [];
  const activityId = opts.activityId ?? 1;
  const returningRows = opts.returningRows ?? [{ id: activityId }];

  const onConflictResult = Object.create(null);
  onConflictResult.returning = vi.fn().mockResolvedValue(returningRows);

  const valuesResult = Object.create(null);
  valuesResult.onConflictDoUpdate = vi.fn().mockReturnValue(onConflictResult);

  const db = Object.create(null);
  db.select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(selectResult),
      }),
    }),
  });
  db.insert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue(valuesResult),
  });
  db.delete = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  });
  db.execute = vi.fn();
  return db;
}

describe("RideWithGpsProvider — sync", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("returns error when no tokens are found", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue(null);

    const provider = new RideWithGpsProvider();
    const db = createChainProxy();
    const result = await provider.sync(db, new Date("2026-01-01"));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found for RideWithGPS");
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(10_000);
  });

  it("returns valid tokens when not expired", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "valid-token",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    });
    vi.mocked(ensureProvider).mockResolvedValue("");

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/sync.json")) {
        return Response.json({ items: [], meta: { rwgps_datetime: "2026-03-15T00:00:00Z" } });
      }
      return Response.json({});
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const db = createSyncMockDb();
    const result = await provider.sync(db, new Date("2026-01-01"));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.provider).toBe("ride-with-gps");
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(10_000);
  });

  it("refreshes expired token", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";
    const { loadTokens, saveTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "expired-token",
      refreshToken: "refresh-tok",
      expiresAt: new Date("2020-01-01"),
      scopes: "user",
    });
    vi.mocked(saveTokens).mockResolvedValue();
    vi.mocked(ensureProvider).mockResolvedValue("");

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      if (input.toString().includes("/sync.json")) {
        return Response.json({ items: [], meta: {} });
      }
      return Response.json({});
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const db = createSyncMockDb();
    const result = await provider.sync(db, new Date("2026-01-01"));

    const { refreshAccessToken } = await import("../auth/oauth.ts");
    expect(refreshAccessToken).toHaveBeenCalled();
    expect(saveTokens).toHaveBeenCalled();
    expect(result.errors).toHaveLength(0);
  });

  it("returns error when token expired and no refresh token", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";
    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "expired",
      refreshToken: null,
      expiresAt: new Date("2020-01-01"),
      scopes: "user",
    });
    vi.mocked(ensureProvider).mockResolvedValue("");

    const provider = new RideWithGpsProvider();
    const db = createChainProxy();
    const result = await provider.sync(db, new Date("2026-01-01"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No refresh token");
  });

  it("returns error when sync API call fails", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "valid",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    });
    vi.mocked(ensureProvider).mockResolvedValue("");

    const mockFetch: typeof globalThis.fetch = async () => {
      return new Response("Server Error", { status: 500 });
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const db = createSyncMockDb();
    const result = await provider.sync(db, new Date("2026-01-01"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Sync endpoint failed");
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(10_000);
  });

  it("uses since param when no sync cursor exists", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "valid",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    });
    vi.mocked(ensureProvider).mockResolvedValue("");

    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return Response.json({ items: [], meta: { rwgps_datetime: "2026-03-15T00:00:00Z" } });
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const db = createSyncMockDb({ syncCursor: null });
    await provider.sync(db, new Date("2026-03-01T00:00:00Z"));

    expect(capturedUrl).toContain("since=2026-03-01");
  });

  it("uses stored sync cursor when available", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "valid",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    });
    vi.mocked(ensureProvider).mockResolvedValue("");

    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return Response.json({ items: [], meta: { rwgps_datetime: "2026-03-15T00:00:00Z" } });
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const db = createSyncMockDb({ syncCursor: "2026-02-14T03:00:00Z" });
    await provider.sync(db, new Date("2026-03-01T00:00:00Z"));

    expect(capturedUrl).toContain("since=2026-02-14");
  });

  it("falls back to since when stored cursor payload is malformed", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "valid",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    });
    vi.mocked(ensureProvider).mockResolvedValue("");

    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return Response.json({ items: [], meta: { rwgps_datetime: "2026-03-15T00:00:00Z" } });
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const db = createSyncMockDb({ settingsValue: {} });
    await provider.sync(db, new Date("2026-03-01T00:00:00Z"));

    expect(capturedUrl).toContain("since=2026-03-01");
  });

  it("does not fail when sync response omits meta", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "valid",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    });
    vi.mocked(ensureProvider).mockResolvedValue("");

    const mockFetch: typeof globalThis.fetch = async () => {
      return Response.json({ items: [] });
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const db = createSyncMockDb();
    const result = await provider.sync(db, new Date("2026-03-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
  });

  it("syncs a trip with track points", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "valid",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    });
    vi.mocked(ensureProvider).mockResolvedValue("");

    const tripDetail = {
      id: 42,
      name: "Morning Ride",
      description: null,
      departed_at: "2026-03-15T07:00:00Z",
      activity_type: "cycling",
      distance: 50000,
      duration: 7200,
      moving_time: 6800,
      elevation_gain: 500,
      elevation_loss: 500,
      created_at: "2026-03-15T10:00:00Z",
      updated_at: "2026-03-15T10:00:00Z",
      track_points: [
        { x: -122.6, y: 45.5, d: 0, t: 1742025600, s: 25, h: 140, p: 200 },
        { x: -122.61, y: 45.51, d: 100, t: 1742025610, s: 30 },
      ],
    };

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/sync.json")) {
        return Response.json({
          items: [{ item_type: "trip", item_id: 42, action: "created" }],
          meta: { rwgps_datetime: "2026-03-15T12:00:00Z" },
        });
      }
      if (url.includes("/trips/42.json")) {
        return Response.json({ trip: tripDetail });
      }
      return Response.json({});
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const db = createSyncMockDb({ activityId: 7 });
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(db.insert).toHaveBeenCalled();
    expect(db.delete).toHaveBeenCalled();

    const valuesMock = db.insert.mock.results[0]?.value.values;
    const onConflictDoUpdateMock = valuesMock.mock.results[0]?.value.onConflictDoUpdate;
    const returningMock = onConflictDoUpdateMock.mock.results[0]?.value.returning;
    const activityInsertArg = valuesMock.mock.calls
      .map((call: unknown[]) => call[0])
      .find(
        (value: unknown) => typeof value === "object" && value !== null && "externalId" in value,
      );
    const sensorInsertArg = valuesMock.mock.calls
      .map((call: unknown[]) => call[0])
      .find((value: unknown) => Array.isArray(value));
    const raw = activityInsertArg ? Reflect.get(activityInsertArg, "raw") : undefined;
    const rawTrackPoints = raw ? Reflect.get(raw, "track_points") : undefined;
    const firstRawPoint = Array.isArray(rawTrackPoints) ? rawTrackPoints[0] : undefined;

    expect(firstRawPoint).toMatchObject({
      longitude: -122.6,
      latitude: 45.5,
      distanceMeters: 0,
      epochSeconds: 1742025600,
      speedKph: 25,
      heartRateBpm: 140,
      powerWatts: 200,
    });
    expect(firstRawPoint).not.toHaveProperty("x");
    expect(firstRawPoint).not.toHaveProperty("y");
    expect(firstRawPoint).not.toHaveProperty("t");
    expect(firstRawPoint).not.toHaveProperty("s");
    expect(onConflictDoUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.any(Array),
        set: expect.objectContaining({
          activityType: "cycling",
          name: "Morning Ride",
        }),
      }),
    );
    expect(returningMock).toHaveBeenCalledWith(expect.objectContaining({ id: expect.anything() }));

    expect(Array.isArray(sensorInsertArg)).toBe(true);
    if (!Array.isArray(sensorInsertArg)) {
      throw new Error("Expected metric_stream insert payload");
    }
    // 2 points -> 8 channel rows in metric_stream (lat/lng/speed/hr/power + lat/lng/speed)
    expect(sensorInsertArg).toHaveLength(8);
    expect(sensorInsertArg).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activityId: 7,
          providerId: "ride-with-gps",
          channel: "lat",
          scalar: 45.5,
        }),
        expect.objectContaining({
          activityId: 7,
          providerId: "ride-with-gps",
          channel: "lng",
          scalar: -122.6,
        }),
        expect.objectContaining({
          activityId: 7,
          providerId: "ride-with-gps",
          channel: "speed",
          scalar: 25 / 3.6,
        }),
        expect.objectContaining({
          activityId: 7,
          providerId: "ride-with-gps",
          channel: "heart_rate",
          scalar: 140,
        }),
        expect.objectContaining({
          activityId: 7,
          providerId: "ride-with-gps",
          channel: "power",
          scalar: 200,
        }),
      ]),
    );
    expect(sensorInsertArg[0]).toMatchObject({
      activityId: 7,
      providerId: "ride-with-gps",
      sourceType: "api",
    });
  });

  it("skips metric inserts when activity upsert returns no id", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "valid",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    });
    vi.mocked(ensureProvider).mockResolvedValue("");

    const tripDetail = {
      id: 42,
      name: "No Activity Row",
      distance: 50000,
      duration: 7200,
      moving_time: 6800,
      elevation_gain: 500,
      elevation_loss: 500,
      created_at: "2026-03-15T10:00:00Z",
      updated_at: "2026-03-15T10:00:00Z",
      track_points: [{ x: -122.6, y: 45.5, d: 0, t: 1742025600 }],
    };

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/sync.json")) {
        return Response.json({
          items: [{ item_type: "trip", item_id: 42, action: "created" }],
          meta: {},
        });
      }
      if (url.includes("/trips/42.json")) {
        return Response.json({ trip: tripDetail });
      }
      return Response.json({});
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const db = createSyncMockDb({ returningRows: [] });
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("batches metric inserts in chunks of 500", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "valid",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    });
    vi.mocked(ensureProvider).mockResolvedValue("");

    const trackPoints = Array.from({ length: 501 }, (_, i) => ({
      x: -122.6 - i * 0.0001,
      y: 45.5 + i * 0.0001,
      d: i * 10,
      t: 1742025600 + i * 5,
      s: 20 + (i % 5),
    }));
    const tripDetail = {
      id: 99,
      name: "Batch Ride",
      distance: 50000,
      duration: 7200,
      moving_time: 6800,
      elevation_gain: 500,
      elevation_loss: 500,
      created_at: "2026-03-15T10:00:00Z",
      updated_at: "2026-03-15T10:00:00Z",
      track_points: trackPoints,
    };

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/sync.json")) {
        return Response.json({
          items: [{ item_type: "trip", item_id: 99, action: "created" }],
          meta: {},
        });
      }
      if (url.includes("/trips/99.json")) {
        return Response.json({ trip: tripDetail });
      }
      return Response.json({});
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const db = createSyncMockDb({ activityId: 11 });
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);

    const valuesMock = db.insert.mock.results[0]?.value.values;
    const metricInsertCalls = valuesMock.mock.calls
      .map((call: unknown[]) => call[0])
      .filter((value: unknown) => Array.isArray(value));

    // 501 points with lat/lng/speed -> 1503 metric_stream rows in one batch
    expect(metricInsertCalls).toHaveLength(1);
    expect(metricInsertCalls[0]).toHaveLength(1503);
  });

  it("handles deleted trip items", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "valid",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    });
    vi.mocked(ensureProvider).mockResolvedValue("");

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      if (input.toString().includes("/sync.json")) {
        return Response.json({
          items: [{ item_type: "trip", item_id: 99, action: "deleted" }],
          meta: { rwgps_datetime: "2026-03-15T12:00:00Z" },
        });
      }
      return Response.json({});
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const db = createSyncMockDb();
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.errors).toHaveLength(0);
    expect(db.delete).toHaveBeenCalled();
  });

  it("skips non-trip items", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "valid",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    });
    vi.mocked(ensureProvider).mockResolvedValue("");

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      if (input.toString().includes("/sync.json")) {
        return Response.json({
          items: [{ item_type: "route", item_id: 50, action: "created" }],
          meta: {},
        });
      }
      return Response.json({});
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const db = createSyncMockDb();
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("catches and records trip sync errors", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "valid",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    });
    vi.mocked(ensureProvider).mockResolvedValue("");

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/sync.json")) {
        return Response.json({
          items: [{ item_type: "trip", item_id: 42, action: "created" }],
          meta: {},
        });
      }
      return new Response("Not Found", { status: 404 });
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const db = createSyncMockDb();
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Failed to sync trip 42");
  });

  it("catches and records delete errors", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "valid",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    });
    vi.mocked(ensureProvider).mockResolvedValue("");

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      if (input.toString().includes("/sync.json")) {
        return Response.json({
          items: [{ item_type: "trip", item_id: 77, action: "removed" }],
          meta: {},
        });
      }
      return Response.json({});
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const db = createSyncMockDb();
    db.delete.mockReturnValue({
      where: vi.fn().mockRejectedValue(new Error("DB error")),
    });
    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Failed to delete trip 77");
  });

  it("saves sync cursor when rwgps_datetime is present", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "valid",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: "user",
    });
    vi.mocked(ensureProvider).mockResolvedValue("");

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      if (input.toString().includes("/sync.json")) {
        return Response.json({
          items: [],
          meta: { rwgps_datetime: "2026-03-15T12:00:00Z" },
        });
      }
      return Response.json({});
    };

    const provider = new RideWithGpsProvider(mockFetch);
    const db = createSyncMockDb();
    await provider.sync(db, new Date("2026-03-01"));

    expect(db.insert).toHaveBeenCalled();
  });
});
