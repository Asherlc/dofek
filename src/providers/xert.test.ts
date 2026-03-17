import { describe, expect, it } from "vitest";
import { mapXertSport, parseXertActivity, XertProvider, xertOAuthConfig } from "./xert.ts";

describe("mapXertSport", () => {
  it("maps Cycling to cycling", () => {
    expect(mapXertSport("Cycling")).toBe("cycling");
  });

  it("maps Running to running", () => {
    expect(mapXertSport("Running")).toBe("running");
  });

  it("maps Swimming to swimming", () => {
    expect(mapXertSport("Swimming")).toBe("swimming");
  });

  it("maps Walking to walking", () => {
    expect(mapXertSport("Walking")).toBe("walking");
  });

  it("maps Hiking to hiking", () => {
    expect(mapXertSport("Hiking")).toBe("hiking");
  });

  it("maps Rowing to rowing", () => {
    expect(mapXertSport("Rowing")).toBe("rowing");
  });

  it("maps Skiing to skiing", () => {
    expect(mapXertSport("Skiing")).toBe("skiing");
  });

  it("maps Virtual Cycling to cycling", () => {
    expect(mapXertSport("Virtual Cycling")).toBe("cycling");
  });

  it("maps Mountain Biking to mountain_biking", () => {
    expect(mapXertSport("Mountain Biking")).toBe("mountain_biking");
  });

  it("maps Trail Running to trail_running", () => {
    expect(mapXertSport("Trail Running")).toBe("trail_running");
  });

  it("maps Cross Country Skiing to cross_country_skiing", () => {
    expect(mapXertSport("Cross Country Skiing")).toBe("cross_country_skiing");
  });

  it("defaults to other for unknown sport", () => {
    expect(mapXertSport("Unknown")).toBe("other");
    expect(mapXertSport("")).toBe("other");
  });

  it("is case-sensitive (does not match lowercase)", () => {
    expect(mapXertSport("cycling")).toBe("other");
    expect(mapXertSport("running")).toBe("other");
  });
});

describe("parseXertActivity", () => {
  const sampleActivity = {
    id: 12345,
    name: "Morning Ride",
    sport: "Cycling",
    startTimestamp: 1710500000,
    endTimestamp: 1710503600,
    duration: 3600,
    distance: 30000,
    power_avg: 200,
    power_max: 450,
    power_normalized: 220,
    heartrate_avg: 145,
    heartrate_max: 175,
    cadence_avg: 90,
    cadence_max: 110,
    calories: 800,
    elevation_gain: 500,
    elevation_loss: 480,
    xss: 85,
    focus: 12.5,
    difficulty: 3.2,
  };

  it("converts id to string externalId", () => {
    const result = parseXertActivity(sampleActivity);
    expect(result.externalId).toBe("12345");
  });

  it("maps sport using mapXertSport", () => {
    const result = parseXertActivity(sampleActivity);
    expect(result.activityType).toBe("cycling");

    const runResult = parseXertActivity({ ...sampleActivity, sport: "Running" });
    expect(runResult.activityType).toBe("running");
  });

  it("uses name directly from activity", () => {
    const result = parseXertActivity(sampleActivity);
    expect(result.name).toBe("Morning Ride");
  });

  it("converts startTimestamp from UNIX seconds to Date", () => {
    const result = parseXertActivity(sampleActivity);
    expect(result.startedAt).toEqual(new Date(1710500000 * 1000));
  });

  it("converts endTimestamp from UNIX seconds to Date", () => {
    const result = parseXertActivity(sampleActivity);
    expect(result.endedAt).toEqual(new Date(1710503600 * 1000));
  });

  it("includes all raw fields with camelCase keys", () => {
    const result = parseXertActivity(sampleActivity);
    expect(result.raw).toEqual({
      sport: "Cycling",
      duration: 3600,
      distance: 30000,
      powerAvg: 200,
      powerMax: 450,
      powerNormalized: 220,
      heartrateAvg: 145,
      heartrateMax: 175,
      cadenceAvg: 90,
      cadenceMax: 110,
      calories: 800,
      elevationGain: 500,
      elevationLoss: 480,
      xss: 85,
      focus: 12.5,
      difficulty: 3.2,
    });
  });
});

describe("xertOAuthConfig", () => {
  it("always returns a config (uses public defaults)", () => {
    const original = { ...process.env };
    delete process.env.XERT_CLIENT_ID;
    delete process.env.XERT_CLIENT_SECRET;

    const config = xertOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("xert_public");
    expect(config?.clientSecret).toBe("xert_public");

    process.env = original;
  });

  it("uses custom client id from env", () => {
    const original = { ...process.env };
    process.env.XERT_CLIENT_ID = "custom-id";
    process.env.XERT_CLIENT_SECRET = "custom-secret";

    const config = xertOAuthConfig();
    expect(config?.clientId).toBe("custom-id");
    expect(config?.clientSecret).toBe("custom-secret");

    process.env = original;
  });

  it("has correct authorize and token URLs", () => {
    const config = xertOAuthConfig();
    expect(config?.authorizeUrl).toBe("https://www.xertonline.com/oauth/authorize");
    expect(config?.tokenUrl).toBe("https://www.xertonline.com/oauth/token");
  });

  it("has empty scopes", () => {
    const config = xertOAuthConfig();
    expect(config?.scopes).toEqual([]);
  });

  it("uses basic token auth method", () => {
    const config = xertOAuthConfig();
    expect(config?.tokenAuthMethod).toBe("basic");
  });

  it("uses custom redirect URI from env", () => {
    const original = { ...process.env };
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";

    const config = xertOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");

    process.env = original;
  });

  it("uses default redirect URI when env var is not set", () => {
    const original = { ...process.env };
    delete process.env.OAUTH_REDIRECT_URI;

    const config = xertOAuthConfig();
    expect(config?.redirectUri).toBe("https://localhost:9876/callback");

    process.env = original;
  });
});

describe("XertProvider", () => {
  it("has correct id and name", () => {
    const provider = new XertProvider();
    expect(provider.id).toBe("xert");
    expect(provider.name).toBe("Xert");
  });

  describe("validate", () => {
    it("always returns null (no env vars strictly required)", () => {
      const provider = new XertProvider();
      expect(provider.validate()).toBeNull();
    });
  });

  describe("authSetup", () => {
    it("returns auth setup with public defaults", () => {
      const original = { ...process.env };
      delete process.env.XERT_CLIENT_ID;
      delete process.env.XERT_CLIENT_SECRET;

      const provider = new XertProvider();
      const setup = provider.authSetup();
      expect(setup.oauthConfig.clientId).toBe("xert_public");
      expect(setup.apiBaseUrl).toBe("https://www.xertonline.com");

      process.env = original;
    });
  });
});
