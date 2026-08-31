import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTokens } from "../db/tokens.ts";
import { authFailureReasonFromError } from "./auth-errors.ts";
import {
  CyclingAnalyticsProvider,
  cyclingAnalyticsOAuthConfig,
  parseCyclingAnalyticsRide,
} from "./cycling-analytics.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createMockDatabase } from "./test-helpers.ts";

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
      fn: () => Promise<{ recordCount: number; result: unknown }>,
    ) => {
      const { result } = await fn();
      return result;
    },
  ),
}));

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "00000000-0000-0000-0000-000000000001",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn(async () => "cycling_analytics"),
  loadTokens: vi.fn(async () => ({
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: null,
  })),
  saveTokens: vi.fn(async () => {}),
  deleteTokens: vi.fn(async () => {}),
}));

vi.mock("../db/provider-activity-sync.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../db/provider-activity-sync.ts")>();
  return {
    ...original,
    finishProviderActivityListSync: providerActivityAbsenceMocks.finishProviderActivityListSync,
    upsertProviderActivity: providerActivityAbsenceMocks.upsertProviderActivity,
  };
});

describe("CyclingAnalyticsProvider — rate-limit aware fetch wiring", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockResolvedValue({ id: "activity-id" });
  });

  it("surfaces a 429 as a ProviderRateLimitError tagged with providerId 'cycling_analytics'", async () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });

    const provider = new CyclingAnalyticsProvider(mockFetch);
    const setup = provider.authSetup();

    const err = await setup.exchangeCode?.("any-code").catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("cycling_analytics");
      expect(err.statusCode).toBe(429);
    }
  });

  it("skips rides after the sync window end", async () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/me/rides")) {
        if (url.includes("page=1")) {
          return Response.json({ rides: [] });
        }
        return Response.json({
          rides: [
            {
              id: 1,
              title: "In window",
              date: "2026-03-01T08:00:00Z",
              duration: 3600,
            },
            {
              id: 2,
              title: "After window",
              date: "2026-03-03T08:00:00Z",
              duration: 3600,
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const { db } = createMockDatabase();
    const result = await new CyclingAnalyticsProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "1" }),
      expect.anything(),
    );
    expect(providerActivityAbsenceMocks.upsertProviderActivity).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "2" }),
      expect.anything(),
    );
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        presentExternalIds: new Set(["1"]),
      }),
    );
  });

  it("uses guarded page requests with auth headers and scoped reconciliation", async () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();

    const requests: Array<{ url: string; authorization: string | null; accept: string | null }> =
      [];
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("Authorization"),
        accept: headers.get("Accept"),
      });

      if (String(input).includes("page=0")) {
        return Response.json({
          rides: [
            {
              id: 10,
              title: "First Page Ride",
              date: "2026-03-01T08:00:00Z",
              duration: 3600,
            },
          ],
        });
      }
      return Response.json({ rides: [] });
    };

    const { db } = createMockDatabase();
    const result = await new CyclingAnalyticsProvider(mockFetch).sync(
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
    const firstRequest = requests[0];
    expect(firstRequest).toBeDefined();
    if (!firstRequest) throw new Error("expected first Cycling Analytics request");
    const firstRequestUrl = new URL(firstRequest.url);
    expect(firstRequestUrl.searchParams.get("start_date")).toBe("2026-03-01T00:00:00.000Z");
    expect(firstRequestUrl.searchParams.get("limit")).toBe("50");
    expect(firstRequest.authorization).toBe("Bearer valid-access-token");
    expect(firstRequest.accept).toBe("application/json");
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        userId: "00000000-0000-0000-0000-000000000001",
        presentExternalIds: new Set(["10"]),
      }),
    );
  });

  it("preserves already fetched rides before a later page request fails", async () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();

    const mockFetch: typeof globalThis.fetch = async (input) => {
      if (String(input).includes("page=1")) {
        return new Response("rate exceeded", { status: 503 });
      }

      return Response.json({
        rides: [
          {
            id: 11,
            title: "First Page Ride",
            date: "2026-03-01T08:00:00Z",
            duration: 3600,
          },
        ],
      });
    };

    const { db } = createMockDatabase();
    const result = await new CyclingAnalyticsProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("cycling_analytics API service unavailable");
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "11" }),
      expect.any(Object),
    );
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("syncs rides at the exact sync window end", async () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();

    const mockFetch: typeof globalThis.fetch = async (input) => {
      if (String(input).includes("page=1")) {
        return Response.json({ rides: [] });
      }

      return Response.json({
        rides: [
          {
            id: 20,
            title: "At Window End",
            date: "2026-03-01T12:00:00Z",
            duration: 3600,
          },
        ],
      });
    };

    const { db } = createMockDatabase();
    const result = await new CyclingAnalyticsProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromIsoRange({
          sinceIso: "2026-03-01T00:00:00.000Z",
          untilIso: "2026-03-01T12:00:00.000Z",
        }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "20" }),
      expect.anything(),
    );
  });

  it("returns the provider API error from activity sync", async () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("service down", { status: 502 });
    const { db } = createMockDatabase();
    const result = await new CyclingAnalyticsProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain(
      "cycling_analytics API service unavailable (502): service down",
    );
  });

  it.each([401, 403])(
    "marks a rejected personal token response (%s) as requiring authentication",
    async (status) => {
      const mockFetch: typeof globalThis.fetch = async () =>
        new Response("sensitive rejection response", { status });
      const { db } = createMockDatabase();

      const result = await new CyclingAnalyticsProvider(mockFetch).sync(
        new SyncRun({
          db,
          window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
        }),
      );

      expect(result.recordsSynced).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(authFailureReasonFromError(result.errors[0]?.cause)).toBe("authentication_failed");
      expect(result.errors[0]?.message).not.toContain("sensitive rejection response");
    },
  );

  it("returns elapsed sync duration", async () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:02.000Z"));
    const mockFetch: typeof globalThis.fetch = async () => {
      vi.setSystemTime(new Date("2026-03-01T00:00:02.625Z"));
      return Response.json({ rides: [] });
    };
    const { db } = createMockDatabase();

    try {
      const result = await new CyclingAnalyticsProvider(mockFetch).sync(
        new SyncRun({
          db,
          window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
        }),
      );

      expect(result.duration).toBe(625);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats null rides as an empty page", async () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async () => Response.json({ rides: null });

    const { db } = createMockDatabase();
    const result = await new CyclingAnalyticsProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
  });

  it("rejects malformed ride dates at the API boundary", async () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async () =>
      Response.json({
        rides: [
          {
            id: 1,
            title: "Bad date",
            date: "not-a-date",
            duration: 3600,
          },
        ],
      });

    const { db } = createMockDatabase();
    const result = await new CyclingAnalyticsProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("activity:");
  });
});

describe("parseCyclingAnalyticsRide — edge cases", () => {
  it("handles ride with minimal fields", () => {
    const ride = {
      id: 1,
      title: "Quick Spin",
      date: "2026-03-01T10:00:00Z",
      duration: 1800,
    };

    const parsed = parseCyclingAnalyticsRide(ride);
    expect(parsed.externalId).toBe("1");
    expect(parsed.activityType.canonicalType).toBe("cycling");
    expect(parsed.name).toBe("Quick Spin");
    expect(parsed.startedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
    expect(parsed.endedAt).toEqual(new Date("2026-03-01T10:30:00Z"));
    expect(parsed.raw.distance).toBeUndefined();
    expect(parsed.raw.averagePower).toBeUndefined();
    expect(parsed.raw.calories).toBeUndefined();
    expect(parsed.raw.trainingStressScore).toBeUndefined();
  });

  it("includes all raw fields when present", () => {
    const ride = {
      id: 99,
      title: "Full Ride",
      date: "2026-03-01T08:00:00Z",
      duration: 7200,
      distance: 60000,
      average_power: 200,
      normalized_power: 220,
      max_power: 500,
      average_heart_rate: 145,
      max_heart_rate: 180,
      average_cadence: 88,
      max_cadence: 115,
      elevation_gain: 500,
      elevation_loss: 490,
      average_speed: 8.33,
      max_speed: 15.0,
      calories: 1200,
      training_stress_score: 150,
      intensity_factor: 0.9,
    };

    const parsed = parseCyclingAnalyticsRide(ride);
    expect(parsed.raw.normalizedPower).toBe(220);
    expect(parsed.raw.maxPower).toBe(500);
    expect(parsed.raw.averageCadence).toBe(88);
    expect(parsed.raw.maxCadence).toBe(115);
    expect(parsed.raw.elevationGain).toBe(500);
    expect(parsed.raw.elevationLoss).toBe(490);
    expect(parsed.raw.averageSpeed).toBe(8.33);
    expect(parsed.raw.maxSpeed).toBe(15.0);
    expect(parsed.raw.intensityFactor).toBe(0.9);
  });
});

describe("cyclingAnalyticsOAuthConfig", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when CYCLING_ANALYTICS_CLIENT_ID is not set", () => {
    delete process.env.CYCLING_ANALYTICS_CLIENT_ID;
    delete process.env.CYCLING_ANALYTICS_CLIENT_SECRET;
    expect(cyclingAnalyticsOAuthConfig()).toBeNull();
  });

  it("returns null when CYCLING_ANALYTICS_CLIENT_SECRET is not set", () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    delete process.env.CYCLING_ANALYTICS_CLIENT_SECRET;
    expect(cyclingAnalyticsOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";
    const config = cyclingAnalyticsOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toEqual(["read_rides"]);
    expect(config?.scopeSeparator).toBe(",");
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = cyclingAnalyticsOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when OAUTH_REDIRECT_URI is not set", () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;
    const config = cyclingAnalyticsOAuthConfig();
    expect(config?.redirectUri).toBe("https://dofek.asherlc.com/callback");
  });
});

describe("CyclingAnalyticsProvider", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("is available without deployment OAuth credentials", () => {
    delete process.env.CYCLING_ANALYTICS_CLIENT_ID;
    delete process.env.CYCLING_ANALYTICS_CLIENT_SECRET;
    expect(new CyclingAnalyticsProvider().validate()).toBeNull();
  });

  it("authSetup returns auth setup with OAuth config", () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";
    const setup = new CyclingAnalyticsProvider().authSetup();
    expect(setup.oauthConfig?.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("cyclinganalytics.com");
  });

  it("offers a personal access token flow when deployment OAuth is not configured", async () => {
    delete process.env.CYCLING_ANALYTICS_CLIENT_ID;
    delete process.env.CYCLING_ANALYTICS_CLIENT_SECRET;
    const fetchFn = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(String(input)).toBe("https://www.cyclinganalytics.com/api/me/rides?limit=1");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer personal-token");
      return Response.json({ rides: [] });
    });
    const setup = new CyclingAnalyticsProvider(fetchFn).authSetup();

    expect(setup.oauthConfig).toBeUndefined();
    expect(setup.manualToken).toMatchObject({
      label: "Personal API token",
      instructionsUrl: "https://www.cyclinganalytics.com/developer/api/authentication",
    });
    await expect(setup.manualToken?.exchangeToken("personal-token")).resolves.toMatchObject({
      accessToken: "personal-token",
      refreshToken: null,
      scopes: "read_rides",
    });
  });

  it("syncs with an unexpired personal token when deployment OAuth is not configured", async () => {
    delete process.env.CYCLING_ANALYTICS_CLIENT_ID;
    delete process.env.CYCLING_ANALYTICS_CLIENT_SECRET;
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "personal-access-token",
      refreshToken: null,
      expiresAt: new Date("2099-12-31T00:00:00.000Z"),
      scopes: "read_rides",
    });
    const fetchFn = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer personal-access-token");
      return Response.json({ rides: [] });
    });
    const { db } = createMockDatabase();

    const result = await new CyclingAnalyticsProvider(fetchFn).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01") }),
        userId: "00000000-0000-0000-0000-000000000001",
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("rejects a personal token when validation returns %s", async (status) => {
    const setup = new CyclingAnalyticsProvider(
      async () => new Response("sensitive rejection response", { status }),
    ).authSetup();
    if (!setup.manualToken) throw new Error("expected manual token authentication");

    const error = await setup.manualToken
      .exchangeToken("rejected-token")
      .catch((caught: unknown) => caught);

    expect(authFailureReasonFromError(error)).toBe("authentication_failed");
    expect(error).toMatchObject({
      message:
        "Cycling Analytics rejected this token. Create a personal token with read_rides permission and try again.",
    });
    expect(error instanceof Error ? error.message : "").not.toContain(
      "sensitive rejection response",
    );
  });

  it("reports a safe error when personal token validation fails unexpectedly", async () => {
    const setup = new CyclingAnalyticsProvider(
      async () => new Response("sensitive provider outage", { status: 500 }),
    ).authSetup();
    if (!setup.manualToken) throw new Error("expected manual token authentication");

    const error = await setup.manualToken
      .exchangeToken("personal-token")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      message: "Cycling Analytics token validation failed (500). Try again.",
    });
    expect(error instanceof Error ? error.message : "").not.toContain("sensitive provider outage");
  });

  it("sync returns error when no tokens", async () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "secret";
    vi.mocked(loadTokens).mockResolvedValueOnce(null);
    const { db } = createMockDatabase();
    const result = await new CyclingAnalyticsProvider().sync(
      new SyncRun({ db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
