import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

import { KomootProvider, komootOAuthConfig, mapKomootSport, parseKomootTour } from "./komoot.ts";

async function expectKomootRateLimitError(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toMatchObject({ providerId: "komoot", retryAfterSeconds: 90 });
    return;
  }

  throw new Error("Expected Komoot rate-limit error");
}

// ============================================================
// Tests merged from komoot-coverage.test.ts
// ============================================================

describe("mapKomootSport", () => {
  it("maps all known sport types", () => {
    expect(mapKomootSport("BIKING").canonicalType).toBe("cycling");
    expect(mapKomootSport("E_BIKING").canonicalType).toBe("cycling");
    expect(mapKomootSport("ROAD_CYCLING").canonicalType).toBe("cycling");
    expect(mapKomootSport("MT_BIKING").canonicalType).toBe("cycling");
    expect(mapKomootSport("E_MT_BIKING").canonicalType).toBe("cycling");
    expect(mapKomootSport("GRAVEL_BIKING").canonicalType).toBe("cycling");
    expect(mapKomootSport("E_BIKE_TOURING").canonicalType).toBe("cycling");
    expect(mapKomootSport("RUNNING").canonicalType).toBe("running");
    expect(mapKomootSport("TRAIL_RUNNING").canonicalType).toBe("running");
    expect(mapKomootSport("HIKING").canonicalType).toBe("hiking");
    expect(mapKomootSport("WALKING").canonicalType).toBe("walking");
    expect(mapKomootSport("CLIMBING").canonicalType).toBe("climbing");
    expect(mapKomootSport("SKIING").canonicalType).toBe("skiing");
    expect(mapKomootSport("CROSS_COUNTRY_SKIING").canonicalType).toBe("skiing");
    expect(mapKomootSport("SNOWSHOEING").canonicalType).toBe("snowshoeing");
    expect(mapKomootSport("PADDLING").canonicalType).toBe("paddling");
    expect(mapKomootSport("INLINE_SKATING").canonicalType).toBe("skating");
  });

  it("returns other for unknown", () => {
    expect(mapKomootSport("UNKNOWN").canonicalType).toBe("other");
  });
});

describe("parseKomootTour", () => {
  it("parses a tour with all fields", () => {
    const tour = {
      id: 12345,
      name: "Morning Ride",
      sport: "BIKING",
      date: "2026-03-01T08:00:00Z",
      distance: 30000,
      duration: 3600,
      elevation_up: 300,
      elevation_down: 280,
      status: "public",
      type: "tour_recorded",
    };

    const parsed = parseKomootTour(tour);
    expect(parsed.externalId).toBe("12345");
    expect(parsed.activityType.canonicalType).toBe("cycling");
    expect(parsed.name).toBe("Morning Ride");
    expect(parsed.startedAt).toEqual(new Date("2026-03-01T08:00:00Z"));
    expect(parsed.endedAt).toEqual(new Date(new Date("2026-03-01T08:00:00Z").getTime() + 3600000));
    expect(parsed.raw.distance).toBe(30000);
    expect(parsed.raw.elevationUp).toBe(300);
    expect(parsed.raw.elevationDown).toBe(280);
    expect(parsed.raw.status).toBe("public");
    expect(parsed.raw.type).toBe("tour_recorded");
  });

  it("handles missing elevation", () => {
    const tour = {
      id: 99,
      name: "Walk",
      sport: "WALKING",
      date: "2026-03-01T12:00:00Z",
      distance: 5000,
      duration: 3600,
      status: "private",
      type: "tour_recorded",
    };

    const parsed = parseKomootTour(tour);
    expect(parsed.raw.elevationUp).toBeUndefined();
    expect(parsed.raw.elevationDown).toBeUndefined();
  });
});

describe("komootOAuthConfig", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when missing env vars", () => {
    delete process.env.KOMOOT_CLIENT_ID;
    delete process.env.KOMOOT_CLIENT_SECRET;
    expect(komootOAuthConfig()).toBeNull();
  });

  it("returns null when KOMOOT_CLIENT_SECRET is not set", () => {
    process.env.KOMOOT_CLIENT_ID = "test-id";
    delete process.env.KOMOOT_CLIENT_SECRET;
    expect(komootOAuthConfig()).toBeNull();
  });

  it("returns config when set", () => {
    process.env.KOMOOT_CLIENT_ID = "id";
    process.env.KOMOOT_CLIENT_SECRET = "secret";
    const config = komootOAuthConfig();
    expect(config?.clientId).toBe("id");
    expect(config?.tokenAuthMethod).toBe("basic");
  });

  it("returns config with scopes when both env vars are set", () => {
    process.env.KOMOOT_CLIENT_ID = "test-id";
    process.env.KOMOOT_CLIENT_SECRET = "test-secret";
    const config = komootOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("profile");
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.KOMOOT_CLIENT_ID = "test-id";
    process.env.KOMOOT_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = komootOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when OAUTH_REDIRECT_URI is not set", () => {
    process.env.KOMOOT_CLIENT_ID = "test-id";
    process.env.KOMOOT_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;
    const config = komootOAuthConfig();
    expect(config?.redirectUri).toBe("https://dofek.asherlc.com/callback");
  });
});

describe("KomootProvider", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("validate returns errors", () => {
    delete process.env.KOMOOT_CLIENT_ID;
    delete process.env.KOMOOT_CLIENT_SECRET;
    expect(new KomootProvider().validate()).toContain("KOMOOT_CLIENT_ID");
    process.env.KOMOOT_CLIENT_ID = "id";
    expect(new KomootProvider().validate()).toContain("KOMOOT_CLIENT_SECRET");
  });

  it("validate returns null when set", () => {
    process.env.KOMOOT_CLIENT_ID = "id";
    process.env.KOMOOT_CLIENT_SECRET = "secret";
    expect(new KomootProvider().validate()).toBeNull();
  });

  it("sync returns error when no tokens", async () => {
    process.env.KOMOOT_CLIENT_ID = "id";
    process.env.KOMOOT_CLIENT_SECRET = "secret";
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
    const result = await new KomootProvider().sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("KomootProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.KOMOOT_CLIENT_ID = "test-id";
    process.env.KOMOOT_CLIENT_SECRET = "test-secret";
    const provider = new KomootProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig?.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("komoot.de");
  });

  it("throws the common rate-limit error when token exchange is throttled", async () => {
    process.env.KOMOOT_CLIENT_ID = "test-id";
    process.env.KOMOOT_CLIENT_SECRET = "test-secret";
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("throttled", { status: 429, headers: { "Retry-After": "90" } });

    const provider = new KomootProvider(fetchFn);
    const setup = provider.authSetup();
    const { exchangeCode } = setup;
    if (!exchangeCode) throw new Error("exchangeCode not defined");

    await expectKomootRateLimitError(() => exchangeCode("code"));
  });

  it("replays the documented refresh-token disconnect request", async () => {
    process.env.KOMOOT_CLIENT_ID = "komoot-client";
    process.env.KOMOOT_CLIENT_SECRET = "komoot-secret";
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const revoke = new KomootProvider(fetchFn).authSetup().revokeTokensForAccountErasure;
    if (!revoke) throw new Error("revokeTokensForAccountErasure not defined");
    const tokens = {
      accessToken: "komoot-access",
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      refreshToken: "komoot-refresh",
      scopes: "profile",
    };

    await revoke(tokens);
    await revoke(tokens);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetchFn.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(
        "https://auth-api.main.komoot.net/v1/clients/komoot-client/refresh_tokens/",
      );
      expect(url.searchParams.get("refresh_token")).toBe("komoot-refresh");
      expect(init?.method).toBe("DELETE");
      expect(init?.headers).toEqual({
        Accept: "application/json",
        Authorization: `Basic ${btoa("komoot-client:komoot-secret")}`,
      });
    }
  });

  it("requires a refresh token and the documented 200 response", async () => {
    process.env.KOMOOT_CLIENT_ID = "komoot-client";
    process.env.KOMOOT_CLIENT_SECRET = "komoot-secret";
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const revoke = new KomootProvider(fetchFn).authSetup().revokeTokensForAccountErasure;
    if (!revoke) throw new Error("revokeTokensForAccountErasure not defined");
    const tokens = {
      accessToken: "komoot-access",
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      refreshToken: null,
      scopes: "profile",
    };

    await expect(revoke(tokens)).rejects.toThrow("Reconnect Komoot before deleting your account");
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(revoke({ ...tokens, refreshToken: "komoot-refresh" })).rejects.toThrow(
      "Komoot authorization revocation failed (204)",
    );
  });

  it("throws when env vars are missing", () => {
    delete process.env.KOMOOT_CLIENT_ID;
    delete process.env.KOMOOT_CLIENT_SECRET;
    const provider = new KomootProvider();
    expect(() => provider.authSetup()).toThrow("KOMOOT_CLIENT_ID");
  });
});
