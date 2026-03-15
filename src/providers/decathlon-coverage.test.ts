import { afterEach, describe, expect, it } from "vitest";
import {
  DecathlonProvider,
  decathlonOAuthConfig,
  mapDecathlonSport,
  parseDecathlonActivity,
} from "./decathlon.ts";

describe("decathlonOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when DECATHLON_CLIENT_ID is not set", () => {
    delete process.env.DECATHLON_CLIENT_ID;
    delete process.env.DECATHLON_CLIENT_SECRET;
    expect(decathlonOAuthConfig()).toBeNull();
  });

  it("returns null when DECATHLON_CLIENT_SECRET is not set", () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    delete process.env.DECATHLON_CLIENT_SECRET;
    expect(decathlonOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";
    const config = decathlonOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
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

describe("DecathlonProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when DECATHLON_CLIENT_ID is missing", () => {
    delete process.env.DECATHLON_CLIENT_ID;
    delete process.env.DECATHLON_CLIENT_SECRET;
    const provider = new DecathlonProvider();
    expect(provider.validate()).toContain("DECATHLON_CLIENT_ID");
  });

  it("returns error when DECATHLON_CLIENT_SECRET is missing", () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    delete process.env.DECATHLON_CLIENT_SECRET;
    const provider = new DecathlonProvider();
    expect(provider.validate()).toContain("DECATHLON_CLIENT_SECRET");
  });

  it("returns null when both are set", () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";
    const provider = new DecathlonProvider();
    expect(provider.validate()).toBeNull();
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

describe("mapDecathlonSport — additional mappings", () => {
  it("maps mountain biking", () => {
    expect(mapDecathlonSport("/v2/sports/153")).toBe("mountain_biking");
  });

  it("maps walking", () => {
    expect(mapDecathlonSport("/v2/sports/320")).toBe("walking");
  });

  it("maps trail running", () => {
    expect(mapDecathlonSport("/v2/sports/274")).toBe("trail_running");
  });

  it("maps water sports", () => {
    expect(mapDecathlonSport("/v2/sports/263")).toBe("open_water_swimming");
    expect(mapDecathlonSport("/v2/sports/173")).toBe("rowing");
    expect(mapDecathlonSport("/v2/sports/174")).toBe("indoor_rowing");
  });

  it("maps winter sports", () => {
    expect(mapDecathlonSport("/v2/sports/79")).toBe("cross_country_skiing");
    expect(mapDecathlonSport("/v2/sports/91")).toBe("skiing");
  });

  it("maps gym/fitness activities", () => {
    expect(mapDecathlonSport("/v2/sports/395")).toBe("yoga");
    expect(mapDecathlonSport("/v2/sports/105")).toBe("gym");
    expect(mapDecathlonSport("/v2/sports/264")).toBe("triathlon");
    expect(mapDecathlonSport("/v2/sports/292")).toBe("skating");
    expect(mapDecathlonSport("/v2/sports/160")).toBe("climbing");
    expect(mapDecathlonSport("/v2/sports/100")).toBe("cross_training");
    expect(mapDecathlonSport("/v2/sports/367")).toBe("elliptical");
    expect(mapDecathlonSport("/v2/sports/176")).toBe("strength_training");
  });
});

describe("parseDecathlonActivity — edge cases", () => {
  it("handles empty dataSummaries array", () => {
    const act = {
      id: "act-empty",
      name: "Walk",
      sport: "/v2/sports/320",
      startdate: "2026-03-01T10:00:00Z",
      duration: 1800,
      dataSummaries: [],
    };
    const parsed = parseDecathlonActivity(act);
    expect(parsed.raw.distanceKm).toBeUndefined();
    expect(parsed.raw.calories).toBeUndefined();
    expect(parsed.raw.avgHeartRate).toBeUndefined();
  });
});
