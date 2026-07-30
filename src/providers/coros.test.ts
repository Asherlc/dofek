import { afterEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Mock external dependencies
// ============================================================

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
  ensureProvider: vi.fn(async () => "coros"),
  loadTokens: vi.fn(async () => ({
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "",
  })),
  saveTokens: vi.fn(async () => {}),
}));

vi.mock("../auth/oauth.ts", () => ({
  exchangeCodeForTokens: vi.fn(async () => ({
    accessToken: "exchanged-token",
    refreshToken: "exchanged-refresh",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "",
  })),
  getOAuthRedirectUri: vi.fn(
    () => process.env.OAUTH_REDIRECT_URI ?? "https://dofek.asherlc.com/callback",
  ),
  refreshAccessToken: vi.fn(async () => ({
    accessToken: "refreshed-token",
    refreshToken: "refreshed-refresh",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "",
  })),
}));

import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { ZodError } from "zod";
import { exchangeCodeForTokens } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";
import {
  activity as activityTable,
  dailyMetrics as dailyMetricsTable,
  sleepSession as sleepSessionTable,
} from "../db/schema/activity.ts";
import * as fitImportQueueModule from "../jobs/enqueue-fit-file-import.ts";
import {
  CorosClient,
  CorosProvider,
  corosOAuthConfig,
  mapCorosSportType,
  parseCorosWorkout,
} from "./coros.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

async function expectCorosRateLimitError(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toMatchObject({ providerId: "coros", retryAfterSeconds: 45 });
    return;
  }

  throw new Error("Expected COROS rate-limit error");
}

// ============================================================
// Parsing tests
// ============================================================

describe("mapCorosSportType", () => {
  it("maps known sport modes", () => {
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

  it("returns other for unknown sport modes", () => {
    expect(mapCorosSportType(999)).toBe("other");
    expect(mapCorosSportType(0)).toBe("other");
  });
});

describe("parseCorosWorkout", () => {
  const sampleWorkout = {
    labelId: "wk-001",
    mode: 8,
    subMode: 0,
    startTime: 1740830400, // 2025-03-01 12:00:00 UTC
    endTime: 1740834000, // 2025-03-01 13:00:00 UTC
    duration: 3600,
    distance: 10000,
    avgHeartRate: 155,
    maxHeartRate: 180,
    avgSpeed: 278,
    maxSpeed: 350,
    totalCalories: 600,
    avgCadence: 170,
    avgPower: 250,
    maxPower: 400,
    totalAscent: 100,
    totalDescent: 95,
  };

  it("maps workout fields correctly", () => {
    const parsed = parseCorosWorkout(sampleWorkout);

    expect(parsed.externalId).toBe("wk-001");
    expect(parsed.activityType).toBe("running");
    expect(parsed.name).toBe("COROS running");
    expect(parsed.startedAt).toEqual(new Date(1740830400 * 1000));
    expect(parsed.endedAt).toEqual(new Date(1740834000 * 1000));
  });

  it("includes raw data", () => {
    const parsed = parseCorosWorkout(sampleWorkout);

    expect(parsed.raw.distance).toBe(10000);
    expect(parsed.raw.avgHeartRate).toBe(155);
    expect(parsed.raw.maxHeartRate).toBe(180);
    expect(parsed.raw.avgPower).toBe(250);
    expect(parsed.raw.totalAscent).toBe(100);
    expect(parsed.raw.mode).toBe(8);
  });

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

// ============================================================
// Provider tests
// ============================================================

describe("CorosProvider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("properties", () => {
    it("has correct id, name, and webhookScope", () => {
      const provider = new CorosProvider();
      expect(provider.id).toBe("coros");
      expect(provider.name).toBe("COROS");
      expect(provider.webhookScope).toBe("app");
    });
  });

  describe("validate()", () => {
    it("returns error when COROS_CLIENT_ID is missing", () => {
      delete process.env.COROS_CLIENT_ID;
      const provider = new CorosProvider();
      expect(provider.validate()).toContain("COROS_CLIENT_ID");
    });

    it("returns error when COROS_CLIENT_SECRET is missing", () => {
      process.env.COROS_CLIENT_ID = "test-id";
      delete process.env.COROS_CLIENT_SECRET;
      const provider = new CorosProvider();
      expect(provider.validate()).toContain("COROS_CLIENT_SECRET");
    });

    it("returns null when both env vars are set", () => {
      process.env.COROS_CLIENT_ID = "test-id";
      process.env.COROS_CLIENT_SECRET = "test-secret";
      const provider = new CorosProvider();
      expect(provider.validate()).toBeNull();
    });
  });

  describe("authSetup()", () => {
    it("returns auth setup with OAuth config", () => {
      process.env.COROS_CLIENT_ID = "test-id";
      process.env.COROS_CLIENT_SECRET = "test-secret";
      const setup = new CorosProvider().authSetup();
      expect(setup.oauthConfig?.clientId).toBe("test-id");
      expect(setup.exchangeCode).toBeTypeOf("function");
      expect(setup.apiBaseUrl).toContain("coros.com");
    });

    it("throws when env vars are missing", () => {
      delete process.env.COROS_CLIENT_ID;
      delete process.env.COROS_CLIENT_SECRET;
      expect(() => new CorosProvider().authSetup()).toThrow("COROS_CLIENT_ID");
    });

    it("passes token exchange throttling through the common rate-limit error", async () => {
      process.env.COROS_CLIENT_ID = "test-id";
      process.env.COROS_CLIENT_SECRET = "test-secret";
      vi.mocked(exchangeCodeForTokens).mockImplementationOnce(
        async (_config, _code, exchangeFetchFn = globalThis.fetch) => {
          await exchangeFetchFn("https://open.coros.com/oauth2/token");
          return {
            accessToken: "access-token",
            refreshToken: "refresh-token",
            expiresAt: new Date("2027-01-01T00:00:00Z"),
            scopes: null,
          };
        },
      );
      const fetchFn: typeof globalThis.fetch = async () =>
        new Response("window exceeded", { status: 429, headers: { "Retry-After": "45" } });
      const provider = new CorosProvider(fetchFn);
      const setup = provider.authSetup();
      const { exchangeCode } = setup;
      if (!exchangeCode) throw new Error("exchangeCode not defined");

      await expectCorosRateLimitError(() => exchangeCode("code"));
    });
  });

  describe("registerWebhook()", () => {
    it("returns static subscription ID (partner-managed)", async () => {
      const provider = new CorosProvider();
      const result = await provider.registerWebhook("https://example.com/wh", "verify-me");

      expect(result.subscriptionId).toBe("coros-partner-subscription");
      expect(result.signingSecret).toBeUndefined();
      expect(result.expiresAt).toBeUndefined();
    });
  });

  describe("unregisterWebhook()", () => {
    it("completes without error (partner-managed)", async () => {
      const provider = new CorosProvider();
      await expect(provider.unregisterWebhook("sub-123")).resolves.toBeUndefined();
    });
  });

  describe("verifyWebhookSignature()", () => {
    it("always returns true (partner agreement)", () => {
      const provider = new CorosProvider();
      expect(provider.verifyWebhookSignature(Buffer.from("test"), {}, "secret")).toBe(true);
    });
  });

  describe("parseWebhookPayload()", () => {
    it("parses sportDataList payload", () => {
      const provider = new CorosProvider();
      const body = {
        sportDataList: [
          { openId: "user-1", labelId: "wk-001" },
          { openId: "user-2", labelId: "wk-002" },
        ],
      };

      const events = provider.parseWebhookPayload(body);

      expect(events).toHaveLength(2);
      expect(events[0]?.ownerExternalId).toBe("user-1");
      expect(events[0]?.eventType).toBe("create");
      expect(events[0]?.objectType).toBe("workout");
      expect(events[0]?.objectId).toBe("wk-001");

      expect(events[1]?.ownerExternalId).toBe("user-2");
      expect(events[1]?.objectId).toBe("wk-002");
    });

    it("parses single openId payload", () => {
      const provider = new CorosProvider();
      const body = { openId: "user-1" };

      const events = provider.parseWebhookPayload(body);

      expect(events).toHaveLength(1);
      expect(events[0]?.ownerExternalId).toBe("user-1");
      expect(events[0]?.eventType).toBe("create");
      expect(events[0]?.objectType).toBe("workout");
    });

    it("handles sportDataList items without labelId", () => {
      const provider = new CorosProvider();
      const body = {
        sportDataList: [{ openId: "user-1" }],
      };

      const events = provider.parseWebhookPayload(body);

      expect(events).toHaveLength(1);
      expect(events[0]?.objectId).toBeUndefined();
    });

    it("filters out invalid items from sportDataList", () => {
      const provider = new CorosProvider();
      const body = {
        sportDataList: [
          { openId: "user-1", labelId: "wk-001" },
          { invalid: true },
          "not-an-object",
        ],
      };

      const events = provider.parseWebhookPayload(body);

      expect(events).toHaveLength(1);
      expect(events[0]?.ownerExternalId).toBe("user-1");
    });

    it("returns empty array for invalid payload", () => {
      const provider = new CorosProvider();
      expect(provider.parseWebhookPayload(null)).toHaveLength(0);
      expect(provider.parseWebhookPayload("string")).toHaveLength(0);
      expect(provider.parseWebhookPayload({ invalid: true })).toHaveLength(0);
    });
  });

  describe("sync()", () => {
    it("returns error when no tokens", async () => {
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

      const result = await new CorosProvider().sync(
        new SyncRun({
          db: mockDb,
          window: SyncWindow.fromSince({ since: new Date("2026-01-01") }),
        }),
      );
      expect(result.provider).toBe("coros");
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it.each([
      null,
      "deepSleep",
      "lightSleep",
      "remSleep",
      "awakeDuration",
    ] as const)("sync uses user-scoped conflict targets and preserves staging completeness (%s absent)", async (missingStage) => {
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
      const enqueueFitImportSpy = vi
        .spyOn(fitImportQueueModule, "enqueueFitFileImportAndWait")
        .mockResolvedValue({ recordsSynced: 0, errors: [] });

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
                fitUrl: "https://cdn.coros.com/workout-w-1.fit",
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
                ...(missingStage === null ? {} : { [missingStage]: undefined }),
              },
            ],
            message: "OK",
            result: "0000",
          });
        }
        if (url === "https://cdn.coros.com/workout-w-1.fit") {
          return new Response(new Uint8Array([1, 2, 3]));
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
      const metricStreamPublisher = {
        publishRows: vi.fn(async () => []),
      };

      const result = await new CorosProvider(mockFetch).sync(
        new SyncRun({
          db: mockDb,
          window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
          userId: "00000000-0000-0000-0000-000000000001",
          metricStreamPublisher,
        }),
      );

      expect(result.errors).toHaveLength(0);
      expect(result.recordsSynced).toBeGreaterThanOrEqual(3);
      expect(enqueueFitImportSpy).toHaveBeenCalledWith({
        fitBuffer: Buffer.from([1, 2, 3]),
        providerId: "coros",
        sourceName: "COROS",
        userId: "00000000-0000-0000-0000-000000000001",
        db: mockDb,
        metricStreamPublisher,
        activitySummary: {
          externalId: "w-1",
          activityType: "running",
          startedAtIso: "2024-03-01T11:00:00.000Z",
          endedAtIso: "2024-03-01T12:00:00.000Z",
          name: "COROS running",
          raw: expect.objectContaining({ distance: 10_000, duration: 3600 }),
        },
      });

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

      const sleepValues = chain.values.mock.calls
        .map((callArgs) => callArgs[0])
        .find(
          (values) =>
            typeof values === "object" &&
            values !== null &&
            Reflect.get(values, "externalId") === "coros-sleep-20260301",
        );
      expect(sleepValues).toMatchObject({
        stagingAvailable: missingStage === null,
      });
    });
  });
});

// ============================================================
// OAuth config tests
// ============================================================

describe("corosOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when env vars are missing", () => {
    delete process.env.COROS_CLIENT_ID;
    delete process.env.COROS_CLIENT_SECRET;
    expect(corosOAuthConfig()).toBeNull();
  });

  it("returns null when COROS_CLIENT_SECRET is not set", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    delete process.env.COROS_CLIENT_SECRET;
    expect(corosOAuthConfig()).toBeNull();
  });

  it("returns config when env vars are set", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    process.env.COROS_CLIENT_SECRET = "test-secret";
    const config = corosOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toEqual([]);
    expect(config?.authorizeUrl).toContain("coros.com");
    expect(config?.tokenUrl).toContain("coros.com");
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

describe("CorosClient.downloadFitFile", () => {
  it("downloads a FIT file and returns a Buffer", async () => {
    const fitBytes = new Uint8Array([0x2e, 0x46, 0x49, 0x54]);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fitBytes.buffer),
    });
    const client = new CorosClient("token", mockFetch);
    const result = await client.downloadFitFile("https://cdn.coros.com/fit/123.fit");

    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(4);
    // FIT file URLs are pre-signed — no auth headers sent.
    expect(mockFetch).toHaveBeenCalledWith("https://cdn.coros.com/fit/123.fit", {
      signal: expect.any(AbortSignal),
    });
  });

  it("throws on download failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const client = new CorosClient("token", mockFetch);

    await expect(client.downloadFitFile("https://cdn.coros.com/bad.fit")).rejects.toThrow(
      "Failed to download FIT file (404)",
    );
  });

  it("throws the common rate-limit error when FIT downloads are throttled", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("slow down", { status: 429, headers: { "Retry-After": "15" } });
    const client = new CorosClient("token", mockFetch);

    await expect(client.downloadFitFile("https://cdn.coros.com/fit/123.fit")).rejects.toMatchObject(
      {
        providerId: "coros",
        retryAfterSeconds: 15,
      },
    );
  });
});
