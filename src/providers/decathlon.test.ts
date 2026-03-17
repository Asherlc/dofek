import { describe, expect, it } from "vitest";
import {
  DecathlonProvider,
  decathlonOAuthConfig,
  mapDecathlonSport,
  parseDecathlonActivity,
} from "./decathlon.ts";

describe("mapDecathlonSport", () => {
  it("maps /v2/sports/381 to running", () => {
    expect(mapDecathlonSport("/v2/sports/381")).toBe("running");
  });

  it("maps /v2/sports/121 to cycling", () => {
    expect(mapDecathlonSport("/v2/sports/121")).toBe("cycling");
  });

  it("maps /v2/sports/153 to mountain_biking", () => {
    expect(mapDecathlonSport("/v2/sports/153")).toBe("mountain_biking");
  });

  it("maps /v2/sports/320 to walking", () => {
    expect(mapDecathlonSport("/v2/sports/320")).toBe("walking");
  });

  it("maps /v2/sports/110 to hiking", () => {
    expect(mapDecathlonSport("/v2/sports/110")).toBe("hiking");
  });

  it("maps /v2/sports/274 to trail_running", () => {
    expect(mapDecathlonSport("/v2/sports/274")).toBe("trail_running");
  });

  it("maps /v2/sports/260 to swimming", () => {
    expect(mapDecathlonSport("/v2/sports/260")).toBe("swimming");
  });

  it("maps /v2/sports/79 to cross_country_skiing", () => {
    expect(mapDecathlonSport("/v2/sports/79")).toBe("cross_country_skiing");
  });

  it("maps /v2/sports/173 to rowing", () => {
    expect(mapDecathlonSport("/v2/sports/173")).toBe("rowing");
  });

  it("maps /v2/sports/263 to open_water_swimming", () => {
    expect(mapDecathlonSport("/v2/sports/263")).toBe("open_water_swimming");
  });

  it("maps /v2/sports/91 to skiing", () => {
    expect(mapDecathlonSport("/v2/sports/91")).toBe("skiing");
  });

  it("maps /v2/sports/174 to indoor_rowing", () => {
    expect(mapDecathlonSport("/v2/sports/174")).toBe("indoor_rowing");
  });

  it("maps /v2/sports/395 to yoga", () => {
    expect(mapDecathlonSport("/v2/sports/395")).toBe("yoga");
  });

  it("maps /v2/sports/105 to gym", () => {
    expect(mapDecathlonSport("/v2/sports/105")).toBe("gym");
  });

  it("maps /v2/sports/264 to triathlon", () => {
    expect(mapDecathlonSport("/v2/sports/264")).toBe("triathlon");
  });

  it("maps /v2/sports/292 to skating", () => {
    expect(mapDecathlonSport("/v2/sports/292")).toBe("skating");
  });

  it("maps /v2/sports/160 to climbing", () => {
    expect(mapDecathlonSport("/v2/sports/160")).toBe("climbing");
  });

  it("maps /v2/sports/100 to cross_training", () => {
    expect(mapDecathlonSport("/v2/sports/100")).toBe("cross_training");
  });

  it("maps /v2/sports/367 to elliptical", () => {
    expect(mapDecathlonSport("/v2/sports/367")).toBe("elliptical");
  });

  it("maps /v2/sports/176 to strength_training", () => {
    expect(mapDecathlonSport("/v2/sports/176")).toBe("strength_training");
  });

  it("defaults to other for unknown sport URI", () => {
    expect(mapDecathlonSport("/v2/sports/99999")).toBe("other");
  });

  it("defaults to other for empty string", () => {
    expect(mapDecathlonSport("")).toBe("other");
  });

  it("extracts sport ID from URI path", () => {
    // Verifies the split/pop logic works with different URI formats
    expect(mapDecathlonSport("381")).toBe("running");
  });
});

describe("parseDecathlonActivity", () => {
  const sampleActivity = {
    id: "act-123",
    name: "Morning Run",
    sport: "/v2/sports/381",
    startdate: "2026-03-15T08:00:00Z",
    duration: 3600,
    dataSummaries: [
      { id: 5, value: 10.5 }, // distance km
      { id: 9, value: 500 }, // calories
      { id: 1, value: 155 }, // avg HR
      { id: 2, value: 180 }, // max HR
    ],
  };

  it("uses id as string externalId", () => {
    const result = parseDecathlonActivity(sampleActivity);
    expect(result.externalId).toBe("act-123");
  });

  it("maps activity type using mapDecathlonSport", () => {
    const result = parseDecathlonActivity(sampleActivity);
    expect(result.activityType).toBe("running");

    const cyclingActivity = { ...sampleActivity, sport: "/v2/sports/121" };
    expect(parseDecathlonActivity(cyclingActivity).activityType).toBe("cycling");
  });

  it("uses name from activity", () => {
    const result = parseDecathlonActivity(sampleActivity);
    expect(result.name).toBe("Morning Run");
  });

  it("parses startdate into startedAt", () => {
    const result = parseDecathlonActivity(sampleActivity);
    expect(result.startedAt).toEqual(new Date("2026-03-15T08:00:00Z"));
  });

  it("calculates endedAt from startedAt + duration in seconds", () => {
    const result = parseDecathlonActivity(sampleActivity);
    const expectedEnd = new Date(new Date("2026-03-15T08:00:00Z").getTime() + 3600 * 1000);
    expect(result.endedAt).toEqual(expectedEnd);
  });

  it("extracts data summaries into raw fields", () => {
    const result = parseDecathlonActivity(sampleActivity);
    expect(result.raw.distanceKm).toBe(10.5);
    expect(result.raw.calories).toBe(500);
    expect(result.raw.avgHeartRate).toBe(155);
    expect(result.raw.maxHeartRate).toBe(180);
  });

  it("includes sport, duration, and full dataSummaries in raw", () => {
    const result = parseDecathlonActivity(sampleActivity);
    expect(result.raw.sport).toBe("/v2/sports/381");
    expect(result.raw.duration).toBe(3600);
    expect(result.raw.dataSummaries).toEqual(sampleActivity.dataSummaries);
  });

  it("handles empty dataSummaries", () => {
    const result = parseDecathlonActivity({ ...sampleActivity, dataSummaries: [] });
    expect(result.raw.distanceKm).toBeUndefined();
    expect(result.raw.calories).toBeUndefined();
    expect(result.raw.avgHeartRate).toBeUndefined();
    expect(result.raw.maxHeartRate).toBeUndefined();
  });

  it("handles empty dataSummaries", () => {
    const actWithEmptySummaries = {
      ...sampleActivity,
      dataSummaries: [],
    };
    const result = parseDecathlonActivity(actWithEmptySummaries);
    expect(result.raw.distanceKm).toBeUndefined();
    expect(result.raw.calories).toBeUndefined();
  });
});

describe("decathlonOAuthConfig", () => {
  it("returns null when env vars are not set", () => {
    const original = { ...process.env };
    delete process.env.DECATHLON_CLIENT_ID;
    delete process.env.DECATHLON_CLIENT_SECRET;

    expect(decathlonOAuthConfig()).toBeNull();

    process.env = original;
  });

  it("returns config when env vars are set", () => {
    const original = { ...process.env };
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";

    const config = decathlonOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toEqual(["openid", "profile"]);
    expect(config?.authorizeUrl).toBe("https://api.decathlon.net/connect/oauth/authorize");
    expect(config?.tokenUrl).toBe("https://api.decathlon.net/connect/oauth/token");

    process.env = original;
  });

  it("returns null when only client id is set", () => {
    const original = { ...process.env };
    process.env.DECATHLON_CLIENT_ID = "test-id";
    delete process.env.DECATHLON_CLIENT_SECRET;

    expect(decathlonOAuthConfig()).toBeNull();

    process.env = original;
  });

  it("uses custom redirect URI from env", () => {
    const original = { ...process.env };
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";

    const config = decathlonOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");

    process.env = original;
  });

  it("uses default redirect URI when env var is not set", () => {
    const original = { ...process.env };
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;

    const config = decathlonOAuthConfig();
    expect(config?.redirectUri).toBe("https://localhost:9876/callback");

    process.env = original;
  });
});

describe("DecathlonProvider", () => {
  it("has correct id and name", () => {
    const provider = new DecathlonProvider();
    expect(provider.id).toBe("decathlon");
    expect(provider.name).toBe("Decathlon");
  });

  describe("validate", () => {
    it("returns error when DECATHLON_CLIENT_ID is not set", () => {
      const original = { ...process.env };
      delete process.env.DECATHLON_CLIENT_ID;
      delete process.env.DECATHLON_CLIENT_SECRET;

      const provider = new DecathlonProvider();
      expect(provider.validate()).toBe("DECATHLON_CLIENT_ID is not set");

      process.env = original;
    });

    it("returns error when DECATHLON_CLIENT_SECRET is not set", () => {
      const original = { ...process.env };
      process.env.DECATHLON_CLIENT_ID = "test-id";
      delete process.env.DECATHLON_CLIENT_SECRET;

      const provider = new DecathlonProvider();
      expect(provider.validate()).toBe("DECATHLON_CLIENT_SECRET is not set");

      process.env = original;
    });

    it("returns null when both env vars are set", () => {
      const original = { ...process.env };
      process.env.DECATHLON_CLIENT_ID = "test-id";
      process.env.DECATHLON_CLIENT_SECRET = "test-secret";

      const provider = new DecathlonProvider();
      expect(provider.validate()).toBeNull();

      process.env = original;
    });
  });

  describe("authSetup", () => {
    it("throws when env vars are not set", () => {
      const original = { ...process.env };
      delete process.env.DECATHLON_CLIENT_ID;
      delete process.env.DECATHLON_CLIENT_SECRET;

      const provider = new DecathlonProvider();
      expect(() => provider.authSetup()).toThrow("DECATHLON_CLIENT_ID and CLIENT_SECRET required");

      process.env = original;
    });

    it("returns auth setup when configured", () => {
      const original = { ...process.env };
      process.env.DECATHLON_CLIENT_ID = "test-id";
      process.env.DECATHLON_CLIENT_SECRET = "test-secret";

      const provider = new DecathlonProvider();
      const setup = provider.authSetup();
      expect(setup.oauthConfig.clientId).toBe("test-id");
      expect(setup.apiBaseUrl).toBe("https://api.decathlon.net/sportstrackingdata/v2");

      process.env = original;
    });
  });
});
