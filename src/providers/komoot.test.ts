import { describe, expect, it } from "vitest";
import { KomootProvider, komootOAuthConfig, mapKomootSport, parseKomootTour } from "./komoot.ts";

describe("mapKomootSport", () => {
  it("maps BIKING to cycling", () => {
    expect(mapKomootSport("BIKING")).toBe("cycling");
  });

  it("maps E_BIKING to cycling", () => {
    expect(mapKomootSport("E_BIKING")).toBe("cycling");
  });

  it("maps ROAD_CYCLING to cycling", () => {
    expect(mapKomootSport("ROAD_CYCLING")).toBe("cycling");
  });

  it("maps MT_BIKING to mountain_biking", () => {
    expect(mapKomootSport("MT_BIKING")).toBe("mountain_biking");
  });

  it("maps E_MT_BIKING to mountain_biking", () => {
    expect(mapKomootSport("E_MT_BIKING")).toBe("mountain_biking");
  });

  it("maps GRAVEL_BIKING to cycling", () => {
    expect(mapKomootSport("GRAVEL_BIKING")).toBe("cycling");
  });

  it("maps E_BIKE_TOURING to cycling", () => {
    expect(mapKomootSport("E_BIKE_TOURING")).toBe("cycling");
  });

  it("maps RUNNING to running", () => {
    expect(mapKomootSport("RUNNING")).toBe("running");
  });

  it("maps TRAIL_RUNNING to trail_running", () => {
    expect(mapKomootSport("TRAIL_RUNNING")).toBe("trail_running");
  });

  it("maps HIKING to hiking", () => {
    expect(mapKomootSport("HIKING")).toBe("hiking");
  });

  it("maps WALKING to walking", () => {
    expect(mapKomootSport("WALKING")).toBe("walking");
  });

  it("maps CLIMBING to climbing", () => {
    expect(mapKomootSport("CLIMBING")).toBe("climbing");
  });

  it("maps SKIING to skiing", () => {
    expect(mapKomootSport("SKIING")).toBe("skiing");
  });

  it("maps CROSS_COUNTRY_SKIING to cross_country_skiing", () => {
    expect(mapKomootSport("CROSS_COUNTRY_SKIING")).toBe("cross_country_skiing");
  });

  it("maps SNOWSHOEING to snowshoeing", () => {
    expect(mapKomootSport("SNOWSHOEING")).toBe("snowshoeing");
  });

  it("maps PADDLING to paddling", () => {
    expect(mapKomootSport("PADDLING")).toBe("paddling");
  });

  it("maps INLINE_SKATING to skating", () => {
    expect(mapKomootSport("INLINE_SKATING")).toBe("skating");
  });

  it("defaults to other for unknown sport", () => {
    expect(mapKomootSport("UNKNOWN")).toBe("other");
    expect(mapKomootSport("")).toBe("other");
  });

  it("is case-sensitive", () => {
    expect(mapKomootSport("biking")).toBe("other");
    expect(mapKomootSport("Hiking")).toBe("other");
  });
});

describe("parseKomootTour", () => {
  const sampleTour = {
    id: 98765,
    name: "Morning Hike",
    sport: "HIKING",
    date: "2026-03-15T08:00:00Z",
    distance: 12000,
    duration: 7200,
    elevation_up: 350,
    elevation_down: 340,
    status: "public",
    type: "tour_recorded",
  };

  it("converts id to string externalId", () => {
    const result = parseKomootTour(sampleTour);
    expect(result.externalId).toBe("98765");
  });

  it("maps activity type using mapKomootSport", () => {
    const result = parseKomootTour(sampleTour);
    expect(result.activityType).toBe("hiking");

    const cyclingTour = { ...sampleTour, sport: "BIKING" };
    expect(parseKomootTour(cyclingTour).activityType).toBe("cycling");
  });

  it("uses name from tour", () => {
    const result = parseKomootTour(sampleTour);
    expect(result.name).toBe("Morning Hike");
  });

  it("parses date into startedAt", () => {
    const result = parseKomootTour(sampleTour);
    expect(result.startedAt).toEqual(new Date("2026-03-15T08:00:00Z"));
  });

  it("calculates endedAt from startedAt + duration in seconds", () => {
    const result = parseKomootTour(sampleTour);
    const expectedEnd = new Date(new Date("2026-03-15T08:00:00Z").getTime() + 7200 * 1000);
    expect(result.endedAt).toEqual(expectedEnd);
  });

  it("includes all raw fields", () => {
    const result = parseKomootTour(sampleTour);
    expect(result.raw).toEqual({
      sport: "HIKING",
      distance: 12000,
      duration: 7200,
      elevationUp: 350,
      elevationDown: 340,
      status: "public",
      type: "tour_recorded",
    });
  });

  it("handles undefined optional elevation fields", () => {
    const tourWithoutElevation = {
      ...sampleTour,
      elevation_up: undefined,
      elevation_down: undefined,
    };
    const result = parseKomootTour(tourWithoutElevation);
    expect(result.raw.elevationUp).toBeUndefined();
    expect(result.raw.elevationDown).toBeUndefined();
  });
});

describe("komootOAuthConfig", () => {
  it("returns null when env vars are not set", () => {
    const original = { ...process.env };
    delete process.env.KOMOOT_CLIENT_ID;
    delete process.env.KOMOOT_CLIENT_SECRET;

    expect(komootOAuthConfig()).toBeNull();

    process.env = original;
  });

  it("returns config when env vars are set", () => {
    const original = { ...process.env };
    process.env.KOMOOT_CLIENT_ID = "test-id";
    process.env.KOMOOT_CLIENT_SECRET = "test-secret";

    const config = komootOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toEqual(["profile"]);
    expect(config?.authorizeUrl).toBe("https://auth.komoot.de/oauth/authorize");
    expect(config?.tokenUrl).toBe("https://auth.komoot.de/oauth/token");
    expect(config?.tokenAuthMethod).toBe("basic");

    process.env = original;
  });

  it("returns null when only client id is set", () => {
    const original = { ...process.env };
    process.env.KOMOOT_CLIENT_ID = "test-id";
    delete process.env.KOMOOT_CLIENT_SECRET;

    expect(komootOAuthConfig()).toBeNull();

    process.env = original;
  });

  it("uses custom redirect URI from env", () => {
    const original = { ...process.env };
    process.env.KOMOOT_CLIENT_ID = "test-id";
    process.env.KOMOOT_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";

    const config = komootOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");

    process.env = original;
  });

  it("uses default redirect URI when env var is not set", () => {
    const original = { ...process.env };
    process.env.KOMOOT_CLIENT_ID = "test-id";
    process.env.KOMOOT_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;

    const config = komootOAuthConfig();
    expect(config?.redirectUri).toBe("https://localhost:9876/callback");

    process.env = original;
  });
});

describe("KomootProvider", () => {
  it("has correct id and name", () => {
    const provider = new KomootProvider();
    expect(provider.id).toBe("komoot");
    expect(provider.name).toBe("Komoot");
  });

  describe("validate", () => {
    it("returns error when KOMOOT_CLIENT_ID is not set", () => {
      const original = { ...process.env };
      delete process.env.KOMOOT_CLIENT_ID;
      delete process.env.KOMOOT_CLIENT_SECRET;

      const provider = new KomootProvider();
      expect(provider.validate()).toBe("KOMOOT_CLIENT_ID is not set");

      process.env = original;
    });

    it("returns error when KOMOOT_CLIENT_SECRET is not set", () => {
      const original = { ...process.env };
      process.env.KOMOOT_CLIENT_ID = "test-id";
      delete process.env.KOMOOT_CLIENT_SECRET;

      const provider = new KomootProvider();
      expect(provider.validate()).toBe("KOMOOT_CLIENT_SECRET is not set");

      process.env = original;
    });

    it("returns null when both env vars are set", () => {
      const original = { ...process.env };
      process.env.KOMOOT_CLIENT_ID = "test-id";
      process.env.KOMOOT_CLIENT_SECRET = "test-secret";

      const provider = new KomootProvider();
      expect(provider.validate()).toBeNull();

      process.env = original;
    });
  });

  describe("authSetup", () => {
    it("throws when env vars are not set", () => {
      const original = { ...process.env };
      delete process.env.KOMOOT_CLIENT_ID;
      delete process.env.KOMOOT_CLIENT_SECRET;

      const provider = new KomootProvider();
      expect(() => provider.authSetup()).toThrow("KOMOOT_CLIENT_ID and CLIENT_SECRET required");

      process.env = original;
    });

    it("returns auth setup when configured", () => {
      const original = { ...process.env };
      process.env.KOMOOT_CLIENT_ID = "test-id";
      process.env.KOMOOT_CLIENT_SECRET = "test-secret";

      const provider = new KomootProvider();
      const setup = provider.authSetup();
      expect(setup.oauthConfig.clientId).toBe("test-id");
      expect(setup.apiBaseUrl).toBe("https://external-api.komoot.de/v007");

      process.env = original;
    });
  });
});
