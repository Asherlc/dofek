import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { describe, expect, it, vi } from "vitest";
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
    expect(mapXertSport("Cycling")).toBe("cycling");
    expect(mapXertSport("Running")).toBe("running");
    expect(mapXertSport("Swimming")).toBe("swimming");
    expect(mapXertSport("Walking")).toBe("walking");
    expect(mapXertSport("Hiking")).toBe("hiking");
    expect(mapXertSport("Rowing")).toBe("rowing");
    expect(mapXertSport("Skiing")).toBe("skiing");
    expect(mapXertSport("Virtual Cycling")).toBe("virtual_cycling");
    expect(mapXertSport("Mountain Biking")).toBe("mountain_biking");
    expect(mapXertSport("Trail Running")).toBe("trail_running");
    expect(mapXertSport("Cross Country Skiing")).toBe("cross_country_skiing");
  });

  it("returns other for unknown", () => {
    expect(mapXertSport("Unknown")).toBe("other");
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
    expect(parsed.activityType).toBe("swimming");
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
  it("returns config with default public client credentials", () => {
    const config = xertOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("xert_public");
    expect(config?.tokenAuthMethod).toBe("basic");
  });

  it("uses custom env vars when set", () => {
    const originalEnv = { ...process.env };
    process.env.XERT_CLIENT_ID = "custom-id";
    process.env.XERT_CLIENT_SECRET = "custom-secret";
    const config = xertOAuthConfig();
    expect(config?.clientId).toBe("custom-id");
    expect(config?.clientSecret).toBe("custom-secret");
    process.env = { ...originalEnv };
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
});
