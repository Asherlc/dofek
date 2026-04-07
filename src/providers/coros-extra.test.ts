import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import {
  activity as activityTable,
  dailyMetrics as dailyMetricsTable,
  sleepSession as sleepSessionTable,
} from "../db/schema.ts";

// Mock modules (needed for sync tests)
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

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn(),
  loadTokens: vi.fn(),
  saveTokens: vi.fn(),
}));

vi.mock("../auth/oauth.ts", () => ({
  exchangeCodeForTokens: vi.fn(),
  getOAuthRedirectUri: vi.fn(
    () => process.env.OAUTH_REDIRECT_URI ?? "https://dofek.asherlc.com/callback",
  ),
  refreshAccessToken: vi.fn(),
}));

import {
  CorosClient,
  CorosProvider,
  corosOAuthConfig,
  mapCorosSportType,
  parseCorosWorkout,
} from "./coros.ts";

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
    expect(config?.redirectUri).toBe("https://dofek.asherlc.com/callback");
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
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const result = await new CorosProvider().sync(mockDb, new Date("2026-01-01"));
    expect(result.provider).toBe("coros");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("sync uses user-scoped conflict targets for activity, daily metrics, and sleep", async () => {
    process.env.COROS_CLIENT_ID = "id";
    process.env.COROS_CLIENT_SECRET = "secret";

    const { loadTokens, ensureProvider } = await import("../db/tokens.ts");
    vi.mocked(ensureProvider).mockResolvedValue("coros");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "valid-token",
      refreshToken: "valid-refresh-token",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      scopes: null,
    });

    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/v2/coros/sport/list")) {
        return Response.json({
          data: [
            {
              labelId: "w-1",
              mode: 8,
              subMode: 0,
              startTime: 1709290800,
              endTime: 1709294400,
              duration: 3600,
              distance: 10000,
              avgHeartRate: 150,
              maxHeartRate: 170,
              avgSpeed: 2.8,
              maxSpeed: 3.5,
              totalCalories: 500,
            },
          ],
          message: "OK",
          result: "0000",
        });
      }
      if (url.includes("/v2/coros/daily/list")) {
        return Response.json({
          data: [
            {
              date: "20260301",
              steps: 8000,
              distance: 6200,
              calories: 2100,
              restingHr: 52,
              hrv: 45,
              spo2Avg: 97,
              sleepDuration: 420,
              deepSleep: 90,
              lightSleep: 220,
              remSleep: 80,
              awakeDuration: 30,
            },
          ],
          message: "OK",
          result: "0000",
        });
      }
      return new Response("Not Found", { status: 404 });
    };

    const chain = {
      values: vi.fn(),
      onConflictDoUpdate: vi.fn(),
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      returning: vi.fn().mockResolvedValue([{ id: "mock-activity-id" }]),
      where: vi.fn().mockResolvedValue(undefined),
    };
    chain.values.mockReturnValue(chain);
    chain.onConflictDoUpdate.mockReturnValue(chain);
    chain.onConflictDoNothing.mockReturnValue(chain);

    const deleteFn = vi.fn().mockReturnValue(chain);

    const mockDb: SyncDatabase = {
      select: vi.fn(),
      insert: vi.fn().mockReturnValue(chain),
      delete: deleteFn,
      execute: vi.fn(),
    };

    const result = await new CorosProvider(mockFetch).sync(
      mockDb,
      new Date("2026-03-01T00:00:00Z"),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(3);

    const targets = chain.onConflictDoUpdate.mock.calls
      .map((callArgs) => callArgs[0])
      .filter((arg): arg is { target: unknown[] } => {
        if (typeof arg !== "object" || arg === null || !("target" in arg)) return false;
        return Array.isArray(Reflect.get(arg, "target"));
      })
      .map((arg) => arg.target);

    expect(
      targets.some(
        (target) =>
          target.length === 3 &&
          target[0] === activityTable.userId &&
          target[1] === activityTable.providerId &&
          target[2] === activityTable.externalId,
      ),
    ).toBe(true);

    expect(
      targets.some(
        (target) =>
          target.length === 4 &&
          target[0] === dailyMetricsTable.userId &&
          target[1] === dailyMetricsTable.date &&
          target[2] === dailyMetricsTable.providerId &&
          target[3] === dailyMetricsTable.sourceName,
      ),
    ).toBe(true);

    expect(
      targets.some(
        (target) =>
          target.length === 3 &&
          target[0] === sleepSessionTable.userId &&
          target[1] === sleepSessionTable.providerId &&
          target[2] === sleepSessionTable.externalId,
      ),
    ).toBe(true);
  });
});

describe("CorosClient", () => {
  it("adds Accept: application/json header", async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch: typeof globalThis.fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {}));
      return Response.json({ data: [], message: "OK", result: "0000" });
    };

    const client = new CorosClient("test-token", mockFetch);
    await client.getWorkouts("20260301", "20260315");

    expect(capturedHeaders.Authorization).toBe("Bearer test-token");
    expect(capturedHeaders.Accept).toBe("application/json");
  });

  it("fetches workouts with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], message: "OK", result: "0000" });
    };

    const client = new CorosClient("token", mockFetch);
    await client.getWorkouts("20260301", "20260315");

    expect(capturedUrl).toContain("/v2/coros/sport/list");
    expect(capturedUrl).toContain("startDate=20260301");
    expect(capturedUrl).toContain("endDate=20260315");
  });

  it("fetches daily data with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], message: "OK", result: "0000" });
    };

    const client = new CorosClient("token", mockFetch);
    await client.getDailyData("20260301", "20260315");

    expect(capturedUrl).toContain("/v2/coros/daily/list");
  });

  it("throws on non-OK response", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new CorosClient("bad-token", mockFetch);
    await expect(client.getWorkouts("20260301", "20260315")).rejects.toThrow("API error 401");
  });

  it("rejects invalid response shapes via Zod", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({ data: "not-an-array" });
    };

    const client = new CorosClient("token", mockFetch);
    await expect(client.getWorkouts("20260301", "20260315")).rejects.toThrow(ZodError);
  });

  it("validates and returns a correct workouts response", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({
        data: [
          {
            labelId: "w-1",
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
          },
        ],
        message: "OK",
        result: "0000",
      });
    };

    const client = new CorosClient("token", mockFetch);
    const result = await client.getWorkouts("20260301", "20260315");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.labelId).toBe("w-1");
  });
});
