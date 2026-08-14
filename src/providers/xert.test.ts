import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

const providerActivityAbsenceMocks = vi.hoisted(() => ({
  finishProviderActivityListSync: vi.fn().mockResolvedValue(undefined),
  upsertProviderActivity: vi.fn().mockResolvedValue({ id: "activity-id" }),
}));

vi.mock("../db/sync-log.ts", () => ({
  PartialSyncError: class PartialSyncError extends Error {
    readonly recordCount: number;
    override readonly cause: unknown;

    constructor(message: string, recordCount: number, cause: unknown) {
      super(message);
      this.name = "PartialSyncError";
      this.recordCount = recordCount;
      this.cause = cause;
    }
  },
  withSyncLog: vi.fn(
    async (
      _db: unknown,
      _providerId: string,
      _dataType: string,
      fn: () => Promise<{ recordCount: number; result: unknown; degradations?: unknown[] }>,
    ) => {
      const { result } = await fn();
      return result;
    },
  ),
}));

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn(async () => "xert"),
  loadTokens: vi.fn(async () => ({
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: null,
  })),
  saveTokens: vi.fn(async () => {}),
}));

vi.mock("../db/provider-activity-sync.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../db/provider-activity-sync.ts")>();
  return {
    ...original,
    finishProviderActivityListSync: providerActivityAbsenceMocks.finishProviderActivityListSync,
    upsertProviderActivity: providerActivityAbsenceMocks.upsertProviderActivity,
  };
});

import { getProviderAuthType } from "./types.ts";
import {
  mapXertSport,
  parseXertActivity,
  signInToXert,
  XertProvider,
  xertOAuthConfig,
} from "./xert.ts";

const rateLimitedFetch: typeof globalThis.fetch = async (): Promise<Response> =>
  new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });

describe("XertProvider — rate-limit aware fetch wiring", () => {
  it("surfaces a 429 from automatedLogin as a ProviderRateLimitError tagged 'xert'", async () => {
    const provider = new XertProvider(rateLimitedFetch);
    const setup = provider.authSetup();

    const err = await setup
      .automatedLogin?.("user@example.com", "password")
      .catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("xert");
      expect(err.statusCode).toBe(429);
    }
  });

  it("surfaces a 429 from signInToXert as a ProviderRateLimitError tagged 'xert'", async () => {
    const err = await signInToXert("user@example.com", "password", rateLimitedFetch).catch(
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("xert");
      expect(err.statusCode).toBe(429);
    }
  });
});

describe("mapXertSport — all types", () => {
  it("maps all known sports", () => {
    expect(mapXertSport("Cycling").canonicalType).toBe("cycling");
    expect(mapXertSport("Running").canonicalType).toBe("running");
    expect(mapXertSport("Swimming").canonicalType).toBe("swimming");
    expect(mapXertSport("Walking").canonicalType).toBe("walking");
    expect(mapXertSport("Hiking").canonicalType).toBe("hiking");
    expect(mapXertSport("Rowing").canonicalType).toBe("rowing");
    expect(mapXertSport("Skiing").canonicalType).toBe("skiing");
    expect(mapXertSport("Virtual Cycling").canonicalType).toBe("cycling");
    expect(mapXertSport("Mountain Biking").canonicalType).toBe("cycling");
    expect(mapXertSport("Trail Running").canonicalType).toBe("running");
    expect(mapXertSport("Cross Country Skiing").canonicalType).toBe("skiing");
  });

  it("returns other for unknown", () => {
    expect(mapXertSport("Unknown").canonicalType).toBe("other");
  });
});

describe("parseXertActivity — edge cases", () => {
  it("includes all raw fields", () => {
    const raw = {
      id: 1,
      name: "Test",
      sport: "Swimming",
      startTimestamp: 1709290800,
      endTimestamp: 1709294400,
      duration: 3600,
      distance: 2000,
      power_avg: 0,
      power_max: 0,
      power_normalized: 0,
      heartrate_avg: 130,
      heartrate_max: 160,
      cadence_avg: 40,
      cadence_max: 50,
      calories: 400,
      elevation_gain: 0,
      elevation_loss: 0,
      xss: 50,
      focus: 90,
      difficulty: 2,
    };

    const parsed = parseXertActivity(raw);
    expect(parsed.activityType.canonicalType).toBe("swimming");
    expect(parsed.raw.heartrateAvg).toBe(130);
    expect(parsed.raw.cadenceAvg).toBe(40);
    expect(parsed.raw.cadenceMax).toBe(50);
    expect(parsed.raw.elevationGain).toBe(0);
    expect(parsed.raw.elevationLoss).toBe(0);
    expect(parsed.raw.focus).toBe(90);
    expect(parsed.raw.difficulty).toBe(2);
  });
});

describe("xertOAuthConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns config with default public client credentials", () => {
    const config = xertOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("xert_public");
    expect(config?.tokenAuthMethod).toBe("basic");
  });

  it("uses custom env vars when set", () => {
    process.env.XERT_CLIENT_ID = "custom-id";
    process.env.XERT_CLIENT_SECRET = "custom-secret";
    const config = xertOAuthConfig();
    expect(config?.clientId).toBe("custom-id");
    expect(config?.clientSecret).toBe("custom-secret");
  });
});

describe("signInToXert", () => {
  it("sends password grant with Basic auth and parses response", async () => {
    const tokenResponse = {
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
    };
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(tokenResponse), { status: 200 }));

    const result = await signInToXert("user@example.com", "hunter2", mockFetch);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://www.xertonline.com/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Basic /),
          "Content-Type": "application/x-www-form-urlencoded",
        }),
      }),
    );

    const body = new URLSearchParams(String(mockFetch.mock.calls[0]?.[1]?.body));
    expect(body.get("grant_type")).toBe("password");
    expect(body.get("username")).toBe("user@example.com");
    expect(body.get("password")).toBe("hunter2");

    expect(result.accessToken).toBe("test-access-token");
    expect(result.refreshToken).toBe("test-refresh-token");
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it("throws on non-OK response", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response("Invalid credentials", { status: 401 }));
    await expect(signInToXert("user@example.com", "wrong", mockFetch)).rejects.toThrow(
      "Xert sign-in failed (401)",
    );
  });

  it("uses default 1-year expiry when expires_in is missing", async () => {
    const tokenResponse = {
      access_token: "tok",
      token_type: "Bearer",
    };
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(tokenResponse), { status: 200 }));
    const before = Date.now();
    const result = await signInToXert("user@example.com", "pass", mockFetch);
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + oneYearMs - 1000);
    expect(result.refreshToken).toBeNull();
  });
});

describe("XertProvider", () => {
  it("validate returns null (always valid)", () => {
    expect(new XertProvider().validate()).toBeNull();
  });

  it("authSetup returns config with automatedLogin", () => {
    const setup = new XertProvider().authSetup();
    expect(setup.oauthConfig?.clientId).toBeDefined();
    expect(setup.apiBaseUrl).toContain("xertonline.com");
    expect(setup.automatedLogin).toBeTypeOf("function");
  });

  it("authSetup.exchangeCode throws (not supported)", async () => {
    const setup = new XertProvider().authSetup();
    await expect(setup.exchangeCode?.("code")).rejects.toThrow("automated login");
  });

  it("is detected as a credential provider", () => {
    expect(getProviderAuthType(new XertProvider())).toBe("credential");
  });

  it("sync returns error when no tokens", async () => {
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
    const result = await new XertProvider().sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("skips activities after the sync window end", async () => {
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();

    const inWindowStart = Math.floor(new Date("2026-03-01T08:00:00Z").getTime() / 1000);
    const afterWindowStart = Math.floor(new Date("2026-03-03T08:00:00Z").getTime() / 1000);
    const mockFetch: typeof globalThis.fetch = async () =>
      Response.json([
        {
          id: 100,
          name: "In Window",
          sport: "Cycling",
          startTimestamp: inWindowStart,
          endTimestamp: inWindowStart + 3600,
          duration: 3600,
          distance: 30000,
          power_avg: 200,
          power_max: 400,
          power_normalized: 210,
          heartrate_avg: 150,
          heartrate_max: 170,
          cadence_avg: 85,
          cadence_max: 100,
          calories: 800,
          elevation_gain: 200,
          elevation_loss: 180,
          xss: 90,
          focus: 3,
          difficulty: 2,
        },
        {
          id: 200,
          name: "After Window",
          sport: "Cycling",
          startTimestamp: afterWindowStart,
          endTimestamp: afterWindowStart + 3600,
          duration: 3600,
          distance: 30000,
          power_avg: 200,
          power_max: 400,
          power_normalized: 210,
          heartrate_avg: 150,
          heartrate_max: 170,
          cadence_avg: 85,
          cadence_max: 100,
          calories: 800,
          elevation_gain: 200,
          elevation_loss: 180,
          xss: 90,
          focus: 3,
          difficulty: 2,
        },
      ]);

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };
    const result = await new XertProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "100" }),
      expect.any(Object),
    );
    expect(providerActivityAbsenceMocks.upsertProviderActivity).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "200" }),
      expect.any(Object),
    );
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        presentExternalIds: new Set(["100"]),
      }),
    );
  });

  it("uses guarded page requests with auth headers and scoped reconciliation", async () => {
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();

    const requests: Array<{ url: string; authorization: string | null; accept: string | null }> =
      [];
    const pageStart = Math.floor(new Date("2026-03-01T08:00:00Z").getTime() / 1000);
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("Authorization"),
        accept: headers.get("Accept"),
      });

      if (String(input).includes("page=0")) {
        return Response.json(
          Array.from({ length: 50 }, (_, index) => ({
            id: 1000 + index,
            name: `Full Page Activity ${index}`,
            sport: "Cycling",
            startTimestamp: pageStart,
            endTimestamp: pageStart + 3600,
            duration: 3600,
            distance: 30000,
            power_avg: 200,
            power_max: 400,
            power_normalized: 210,
            heartrate_avg: 150,
            heartrate_max: 170,
            cadence_avg: 85,
            cadence_max: 100,
            calories: 800,
            elevation_gain: 200,
            elevation_loss: 180,
            xss: 90,
            focus: 3,
            difficulty: 2,
          })),
        );
      }

      return Response.json([]);
    };

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };
    const result = await new XertProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
        userId: "00000000-0000-0000-0000-000000000001",
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(requests.map((request) => new URL(request.url).searchParams.get("page"))).toEqual([
      "0",
      "1",
    ]);
    expect(new URL(requests[0]?.url ?? "").searchParams.get("from")).toBe(
      String(Math.floor(new Date("2026-03-01T00:00:00Z").getTime() / 1000)),
    );
    expect(new URL(requests[0]?.url ?? "").searchParams.get("limit")).toBe("50");
    expect(requests[0]?.authorization).toBe("Bearer valid-access-token");
    expect(requests[0]?.accept).toBe("application/json");
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        userId: "00000000-0000-0000-0000-000000000001",
        presentExternalIds: new Set(Array.from({ length: 50 }, (_, index) => String(1000 + index))),
      }),
    );
  });

  it("syncs activities at the window start and skips activities before the start or at the end", async () => {
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();

    const beforeWindowStart = Math.floor(new Date("2026-02-28T23:59:59Z").getTime() / 1000);
    const atWindowStart = Math.floor(new Date("2026-03-01T00:00:00Z").getTime() / 1000);
    const atWindowEnd = Math.floor(new Date("2026-03-02T00:00:00Z").getTime() / 1000);
    const mockFetch: typeof globalThis.fetch = async () =>
      Response.json([
        {
          id: 300,
          name: "Before Window",
          sport: "Cycling",
          startTimestamp: beforeWindowStart,
          endTimestamp: beforeWindowStart + 3600,
          duration: 3600,
          distance: 30000,
          power_avg: 200,
          power_max: 400,
          power_normalized: 210,
          heartrate_avg: 150,
          heartrate_max: 170,
          cadence_avg: 85,
          cadence_max: 100,
          calories: 800,
          elevation_gain: 200,
          elevation_loss: 180,
          xss: 90,
          focus: 3,
          difficulty: 2,
        },
        {
          id: 400,
          name: "At Window Start",
          sport: "Cycling",
          startTimestamp: atWindowStart,
          endTimestamp: atWindowStart + 3600,
          duration: 3600,
          distance: 30000,
          power_avg: 200,
          power_max: 400,
          power_normalized: 210,
          heartrate_avg: 150,
          heartrate_max: 170,
          cadence_avg: 85,
          cadence_max: 100,
          calories: 800,
          elevation_gain: 200,
          elevation_loss: 180,
          xss: 90,
          focus: 3,
          difficulty: 2,
        },
        {
          id: 500,
          name: "At Window End",
          sport: "Cycling",
          startTimestamp: atWindowEnd,
          endTimestamp: atWindowEnd + 3600,
          duration: 3600,
          distance: 30000,
          power_avg: 200,
          power_max: 400,
          power_normalized: 210,
          heartrate_avg: 150,
          heartrate_max: 170,
          cadence_avg: 85,
          cadence_max: 100,
          calories: 800,
          elevation_gain: 200,
          elevation_loss: 180,
          xss: 90,
          focus: 3,
          difficulty: 2,
        },
      ]);

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };
    const result = await new XertProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "400" }),
      expect.any(Object),
    );
    expect(providerActivityAbsenceMocks.upsertProviderActivity).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "300" }),
      expect.any(Object),
    );
    expect(providerActivityAbsenceMocks.upsertProviderActivity).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "500" }),
      expect.any(Object),
    );
  });

  it("returns the provider API error from activity sync", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("rate exceeded", { status: 503 });
    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };

    const result = await new XertProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain(
      "xert API service unavailable (503): rate exceeded",
    );
  });

  it("preserves already fetched activities before a later page request fails", async () => {
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();

    let requestCount = 0;
    const pageStart = Math.floor(new Date("2026-03-01T08:00:00Z").getTime() / 1000);
    const mockFetch: typeof globalThis.fetch = async () => {
      requestCount++;
      if (requestCount === 2) {
        return new Response("rate exceeded", { status: 503 });
      }

      return Response.json(
        Array.from({ length: 50 }, (_, index) => ({
          id: 7000 + index,
          name: `Persisted Activity ${index}`,
          sport: "Cycling",
          startTimestamp: pageStart,
          endTimestamp: pageStart + 3600,
          duration: 3600,
          distance: 30000,
          power_avg: 200,
          power_max: 400,
          power_normalized: 210,
          heartrate_avg: 150,
          heartrate_max: 170,
          cadence_avg: 85,
          cadence_max: 100,
          calories: 800,
          elevation_gain: 200,
          elevation_loss: 180,
          xss: 90,
          focus: 3,
          difficulty: 2,
        })),
      );
    };
    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };

    const result = await new XertProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.recordsSynced).toBe(50);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("xert API service unavailable");
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledTimes(50);
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("returns elapsed sync duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:01.000Z"));
    const mockFetch: typeof globalThis.fetch = async () => {
      vi.setSystemTime(new Date("2026-03-01T00:00:01.375Z"));
      return Response.json([]);
    };
    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };

    try {
      const result = await new XertProvider(mockFetch).sync(
        new SyncRun({
          db,
          window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
        }),
      );

      expect(result.duration).toBe(375);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports max-page degradation at the exact page guard", async () => {
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();

    let requestCount = 0;
    const pageStart = Math.floor(new Date("2026-03-01T08:00:00Z").getTime() / 1000);
    const mockFetch: typeof globalThis.fetch = async () => {
      requestCount++;
      if (requestCount > 100) {
        return Response.json([]);
      }

      return Response.json(
        Array.from({ length: 50 }, (_, index) => ({
          id: requestCount * 1000 + index,
          name: `Guard Activity ${requestCount}-${index}`,
          sport: "Cycling",
          startTimestamp: pageStart,
          endTimestamp: pageStart + 3600,
          duration: 3600,
          distance: 30000,
          power_avg: 200,
          power_max: 400,
          power_normalized: 210,
          heartrate_avg: 150,
          heartrate_max: 170,
          cadence_avg: 85,
          cadence_max: 100,
          calories: 800,
          elevation_gain: 200,
          elevation_loss: 180,
          xss: 90,
          focus: 3,
          difficulty: 2,
        })),
      );
    };

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };
    const result = await new XertProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(5000);
    expect(result.degradations?.[0]?.kind).toBe("pagination_max_pages_exceeded");
    expect(requestCount).toBe(100);
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).not.toHaveBeenCalled();
  });
});
