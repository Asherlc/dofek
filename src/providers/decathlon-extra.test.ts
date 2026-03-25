import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DecathlonProvider,
  decathlonOAuthConfig,
  mapDecathlonSport,
  parseDecathlonActivity,
} from "./decathlon.ts";

// ============================================================
// Tests merged from decathlon-coverage.test.ts
// ============================================================

describe("mapDecathlonSport — all types", () => {
  it("maps known sport IDs from URI", () => {
    expect(mapDecathlonSport("/v2/sports/381")).toBe("running");
    expect(mapDecathlonSport("/v2/sports/121")).toBe("cycling");
    expect(mapDecathlonSport("/v2/sports/153")).toBe("mountain_biking");
    expect(mapDecathlonSport("/v2/sports/320")).toBe("walking");
    expect(mapDecathlonSport("/v2/sports/110")).toBe("hiking");
    expect(mapDecathlonSport("/v2/sports/274")).toBe("trail_running");
    expect(mapDecathlonSport("/v2/sports/260")).toBe("swimming");
    expect(mapDecathlonSport("/v2/sports/79")).toBe("cross_country_skiing");
    expect(mapDecathlonSport("/v2/sports/173")).toBe("rowing");
    expect(mapDecathlonSport("/v2/sports/263")).toBe("open_water_swimming");
    expect(mapDecathlonSport("/v2/sports/91")).toBe("skiing");
    expect(mapDecathlonSport("/v2/sports/174")).toBe("rowing");
    expect(mapDecathlonSport("/v2/sports/395")).toBe("yoga");
    expect(mapDecathlonSport("/v2/sports/105")).toBe("gym");
    expect(mapDecathlonSport("/v2/sports/264")).toBe("triathlon");
    expect(mapDecathlonSport("/v2/sports/292")).toBe("skating");
    expect(mapDecathlonSport("/v2/sports/160")).toBe("climbing");
    expect(mapDecathlonSport("/v2/sports/100")).toBe("cross_training");
    expect(mapDecathlonSport("/v2/sports/367")).toBe("elliptical");
    expect(mapDecathlonSport("/v2/sports/176")).toBe("strength_training");
  });

  it("returns other for unknown sport ID", () => {
    expect(mapDecathlonSport("/v2/sports/999")).toBe("other");
    expect(mapDecathlonSport("")).toBe("other");
  });
});

describe("parseDecathlonActivity", () => {
  it("parses activity with data summaries", () => {
    const act = {
      id: "dec-123",
      name: "Morning Run",
      sport: "/v2/sports/381",
      startdate: "2026-03-01T08:00:00Z",
      duration: 3600,
      dataSummaries: [
        { id: 5, value: 10 }, // distance km
        { id: 9, value: 500 }, // calories
        { id: 1, value: 150 }, // avg HR
        { id: 2, value: 175 }, // max HR
      ],
    };

    const parsed = parseDecathlonActivity(act);
    expect(parsed.externalId).toBe("dec-123");
    expect(parsed.activityType).toBe("running");
    expect(parsed.name).toBe("Morning Run");
    expect(parsed.startedAt).toEqual(new Date("2026-03-01T08:00:00Z"));
    expect(parsed.endedAt).toEqual(new Date(new Date("2026-03-01T08:00:00Z").getTime() + 3600000));
    expect(parsed.raw.distanceKm).toBe(10);
    expect(parsed.raw.calories).toBe(500);
    expect(parsed.raw.avgHeartRate).toBe(150);
    expect(parsed.raw.maxHeartRate).toBe(175);
    expect(parsed.raw.dataSummaries).toEqual(act.dataSummaries);
  });

  it("handles empty dataSummaries", () => {
    const act = {
      id: "dec-min",
      name: "Walk",
      sport: "/v2/sports/320",
      startdate: "2026-03-01T12:00:00Z",
      duration: 1800,
      dataSummaries: [],
    };

    const parsed = parseDecathlonActivity(act);
    expect(parsed.raw.distanceKm).toBeUndefined();
    expect(parsed.raw.calories).toBeUndefined();
  });
});

describe("decathlonOAuthConfig", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when missing", () => {
    delete process.env.DECATHLON_CLIENT_ID;
    delete process.env.DECATHLON_CLIENT_SECRET;
    expect(decathlonOAuthConfig()).toBeNull();
  });

  it("returns null when DECATHLON_CLIENT_SECRET is not set", () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    delete process.env.DECATHLON_CLIENT_SECRET;
    expect(decathlonOAuthConfig()).toBeNull();
  });

  it("returns config when set", () => {
    process.env.DECATHLON_CLIENT_ID = "id";
    process.env.DECATHLON_CLIENT_SECRET = "secret";
    const config = decathlonOAuthConfig();
    expect(config?.clientId).toBe("id");
    expect(config?.authorizeUrl).toContain("decathlon.net");
  });

  it("returns config with scopes when both env vars are set", () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";
    const config = decathlonOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("openid");
    expect(config?.scopes).toContain("profile");
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = decathlonOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when OAUTH_REDIRECT_URI is not set", () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;
    const config = decathlonOAuthConfig();
    expect(config?.redirectUri).toContain("localhost");
  });
});

describe("DecathlonProvider", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("validate checks env vars", () => {
    delete process.env.DECATHLON_CLIENT_ID;
    delete process.env.DECATHLON_CLIENT_SECRET;
    expect(new DecathlonProvider().validate()).toContain("DECATHLON_CLIENT_ID");
    process.env.DECATHLON_CLIENT_ID = "id";
    expect(new DecathlonProvider().validate()).toContain("DECATHLON_CLIENT_SECRET");
    process.env.DECATHLON_CLIENT_SECRET = "secret";
    expect(new DecathlonProvider().validate()).toBeNull();
  });

  it("sync returns error when no tokens", async () => {
    process.env.DECATHLON_CLIENT_ID = "id";
    process.env.DECATHLON_CLIENT_SECRET = "secret";
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
    const result = await new DecathlonProvider().sync(mockDb, new Date("2026-01-01"));
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("DecathlonProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";
    const provider = new DecathlonProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("decathlon.net");
  });

  it("throws when env vars are missing", () => {
    delete process.env.DECATHLON_CLIENT_ID;
    delete process.env.DECATHLON_CLIENT_SECRET;
    const provider = new DecathlonProvider();
    expect(() => provider.authSetup()).toThrow("DECATHLON_CLIENT_ID");
  });
});
