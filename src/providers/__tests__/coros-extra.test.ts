import { afterEach, describe, expect, it, vi } from "vitest";

// Mock modules (needed for sync tests)
vi.mock("../../db/sync-log.ts", () => ({
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

vi.mock("../../db/tokens.ts", () => ({
  ensureProvider: vi.fn(),
  loadTokens: vi.fn(),
  saveTokens: vi.fn(),
}));

vi.mock("../../auth/oauth.ts", () => ({
  exchangeCodeForTokens: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

import { CorosProvider, corosOAuthConfig, mapCorosSportType, parseCorosWorkout } from "../coros.ts";

// ============================================================
// Tests targeting uncovered paths in coros.ts
// ============================================================

describe("mapCorosSportType", () => {
  it("maps all known sport types", () => {
    expect(mapCorosSportType(8)).toBe("running");
    expect(mapCorosSportType(9)).toBe("cycling");
    expect(mapCorosSportType(10)).toBe("swimming");
    expect(mapCorosSportType(13)).toBe("strength");
    expect(mapCorosSportType(14)).toBe("walking");
    expect(mapCorosSportType(15)).toBe("hiking");
    expect(mapCorosSportType(17)).toBe("rowing");
    expect(mapCorosSportType(18)).toBe("yoga");
    expect(mapCorosSportType(22)).toBe("trail_running");
    expect(mapCorosSportType(23)).toBe("skiing");
    expect(mapCorosSportType(27)).toBe("triathlon");
    expect(mapCorosSportType(100)).toBe("other");
  });

  it("returns other for unknown modes", () => {
    expect(mapCorosSportType(999)).toBe("other");
  });
});

describe("parseCorosWorkout", () => {
  it("parses a workout with all fields", () => {
    const workout = {
      labelId: "coros-w-123",
      mode: 9,
      subMode: 0,
      startTime: 1709290800,
      endTime: 1709294400,
      duration: 3600,
      distance: 30000,
      avgHeartRate: 145,
      maxHeartRate: 175,
      avgSpeed: 8.33,
      maxSpeed: 12.0,
      totalCalories: 700,
      avgCadence: 85,
      avgPower: 200,
      maxPower: 450,
      totalAscent: 300,
      totalDescent: 280,
    };

    const parsed = parseCorosWorkout(workout);
    expect(parsed.externalId).toBe("coros-w-123");
    expect(parsed.activityType).toBe("cycling");
    expect(parsed.name).toBe("COROS cycling");
    expect(parsed.startedAt).toEqual(new Date(1709290800 * 1000));
    expect(parsed.endedAt).toEqual(new Date(1709294400 * 1000));
    expect(parsed.raw.distance).toBe(30000);
    expect(parsed.raw.avgHeartRate).toBe(145);
    expect(parsed.raw.maxHeartRate).toBe(175);
    expect(parsed.raw.avgPower).toBe(200);
    expect(parsed.raw.maxPower).toBe(450);
    expect(parsed.raw.totalAscent).toBe(300);
    expect(parsed.raw.totalDescent).toBe(280);
    expect(parsed.raw.mode).toBe(9);
    expect(parsed.raw.subMode).toBe(0);
  });

  it("handles workout without optional fields", () => {
    const workout = {
      labelId: "min-w",
      mode: 8,
      subMode: 0,
      startTime: 1709290800,
      endTime: 1709292600,
      duration: 1800,
      distance: 5000,
      avgHeartRate: 155,
      maxHeartRate: 180,
      avgSpeed: 2.78,
      maxSpeed: 3.5,
      totalCalories: 300,
    };

    const parsed = parseCorosWorkout(workout);
    expect(parsed.activityType).toBe("running");
    expect(parsed.raw.avgCadence).toBeUndefined();
    expect(parsed.raw.avgPower).toBeUndefined();
  });
});

describe("corosOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when COROS_CLIENT_ID is not set", () => {
    delete process.env.COROS_CLIENT_ID;
    delete process.env.COROS_CLIENT_SECRET;
    expect(corosOAuthConfig()).toBeNull();
  });

  it("returns null when COROS_CLIENT_SECRET is not set", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    delete process.env.COROS_CLIENT_SECRET;
    expect(corosOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    process.env.COROS_CLIENT_SECRET = "test-secret";
    const config = corosOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toEqual([]);
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    process.env.COROS_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = corosOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when OAUTH_REDIRECT_URI is not set", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    process.env.COROS_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;
    const config = corosOAuthConfig();
    expect(config?.redirectUri).toContain("localhost");
  });
});

describe("CorosProvider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("validate returns error when COROS_CLIENT_ID is missing", () => {
    delete process.env.COROS_CLIENT_ID;
    delete process.env.COROS_CLIENT_SECRET;
    expect(new CorosProvider().validate()).toContain("COROS_CLIENT_ID");
  });

  it("validate returns error when COROS_CLIENT_SECRET is missing", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    delete process.env.COROS_CLIENT_SECRET;
    expect(new CorosProvider().validate()).toContain("COROS_CLIENT_SECRET");
  });

  it("validate returns null when both are set", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    process.env.COROS_CLIENT_SECRET = "test-secret";
    expect(new CorosProvider().validate()).toBeNull();
  });

  it("authSetup returns auth setup with OAuth config", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    process.env.COROS_CLIENT_SECRET = "test-secret";
    const setup = new CorosProvider().authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("coros.com");
  });

  it("authSetup throws when env vars are missing", () => {
    delete process.env.COROS_CLIENT_ID;
    delete process.env.COROS_CLIENT_SECRET;
    expect(() => new CorosProvider().authSetup()).toThrow("COROS_CLIENT_ID");
  });

  it("sync returns error when no tokens", async () => {
    process.env.COROS_CLIENT_ID = "id";
    process.env.COROS_CLIENT_SECRET = "secret";
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
    };

    // @ts-expect-error mock DB
    const result = await new CorosProvider().sync(mockDb, new Date("2026-01-01"));
    expect(result.provider).toBe("coros");
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
