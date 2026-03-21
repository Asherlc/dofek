import { describe, expect, it, vi } from "vitest";
import { getProviderAuthType } from "./types.ts";
import {
  mapXertSport,
  parseXertActivity,
  signInToXert,
  XertProvider,
  xertOAuthConfig,
} from "./xert.ts";

describe("mapXertSport — all types", () => {
  it("maps all known sports", () => {
    expect(mapXertSport("Cycling")).toBe("cycling");
    expect(mapXertSport("Running")).toBe("running");
    expect(mapXertSport("Swimming")).toBe("swimming");
    expect(mapXertSport("Walking")).toBe("walking");
    expect(mapXertSport("Hiking")).toBe("hiking");
    expect(mapXertSport("Rowing")).toBe("rowing");
    expect(mapXertSport("Skiing")).toBe("skiing");
    expect(mapXertSport("Virtual Cycling")).toBe("cycling");
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
    expect(setup.oauthConfig.clientId).toBeDefined();
    expect(setup.apiBaseUrl).toContain("xertonline.com");
    expect(setup.automatedLogin).toBeTypeOf("function");
  });

  it("authSetup.exchangeCode throws (not supported)", async () => {
    const setup = new XertProvider().authSetup();
    await expect(setup.exchangeCode("code")).rejects.toThrow("automated login");
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
    const result = await new XertProvider().sync(mockDb, new Date("2026-01-01"));
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
