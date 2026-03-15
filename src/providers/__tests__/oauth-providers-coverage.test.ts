import { afterEach, describe, expect, it } from "vitest";
import { Concept2Provider, concept2OAuthConfig } from "../concept2.ts";
import { CorosProvider, corosOAuthConfig } from "../coros.ts";
import { CyclingAnalyticsProvider, cyclingAnalyticsOAuthConfig } from "../cycling-analytics.ts";
import { DecathlonProvider, decathlonOAuthConfig } from "../decathlon.ts";
import { KomootProvider, komootOAuthConfig } from "../komoot.ts";

// ============================================================
// Concept2
// ============================================================

describe("concept2OAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when CONCEPT2_CLIENT_ID is not set", () => {
    delete process.env.CONCEPT2_CLIENT_ID;
    delete process.env.CONCEPT2_CLIENT_SECRET;
    expect(concept2OAuthConfig()).toBeNull();
  });

  it("returns null when CONCEPT2_CLIENT_SECRET is not set", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    delete process.env.CONCEPT2_CLIENT_SECRET;
    expect(concept2OAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-secret";
    const config = concept2OAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("results:read");
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = concept2OAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when OAUTH_REDIRECT_URI is not set", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;
    const config = concept2OAuthConfig();
    expect(config?.redirectUri).toContain("localhost");
  });
});

describe("Concept2Provider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when CONCEPT2_CLIENT_ID is missing", () => {
    delete process.env.CONCEPT2_CLIENT_ID;
    delete process.env.CONCEPT2_CLIENT_SECRET;
    const provider = new Concept2Provider();
    expect(provider.validate()).toContain("CONCEPT2_CLIENT_ID");
  });

  it("returns error when CONCEPT2_CLIENT_SECRET is missing", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    delete process.env.CONCEPT2_CLIENT_SECRET;
    const provider = new Concept2Provider();
    expect(provider.validate()).toContain("CONCEPT2_CLIENT_SECRET");
  });

  it("returns null when both are set", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-secret";
    const provider = new Concept2Provider();
    expect(provider.validate()).toBeNull();
  });
});

describe("Concept2Provider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-secret";
    const provider = new Concept2Provider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("concept2.com");
  });

  it("throws when env vars are missing", () => {
    delete process.env.CONCEPT2_CLIENT_ID;
    delete process.env.CONCEPT2_CLIENT_SECRET;
    const provider = new Concept2Provider();
    expect(() => provider.authSetup()).toThrow("CONCEPT2_CLIENT_ID");
  });
});

// ============================================================
// COROS
// ============================================================

describe("corosOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when COROS_CLIENT_ID is not set", () => {
    delete process.env.COROS_CLIENT_ID;
    delete process.env.COROS_CLIENT_SECRET;
    expect(corosOAuthConfig()).toBeNull();
  });

  it("returns null when COROS_CLIENT_SECRET is not set", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    delete process.env.COROS_CLIENT_SECRET;
    expect(corosOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    process.env.COROS_CLIENT_SECRET = "test-secret";
    const config = corosOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toEqual([]);
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    process.env.COROS_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = corosOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when OAUTH_REDIRECT_URI is not set", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    process.env.COROS_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;
    const config = corosOAuthConfig();
    expect(config?.redirectUri).toContain("localhost");
  });
});

describe("CorosProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when COROS_CLIENT_ID is missing", () => {
    delete process.env.COROS_CLIENT_ID;
    delete process.env.COROS_CLIENT_SECRET;
    const provider = new CorosProvider();
    expect(provider.validate()).toContain("COROS_CLIENT_ID");
  });

  it("returns error when COROS_CLIENT_SECRET is missing", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    delete process.env.COROS_CLIENT_SECRET;
    const provider = new CorosProvider();
    expect(provider.validate()).toContain("COROS_CLIENT_SECRET");
  });

  it("returns null when both are set", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    process.env.COROS_CLIENT_SECRET = "test-secret";
    const provider = new CorosProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("CorosProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    process.env.COROS_CLIENT_SECRET = "test-secret";
    const provider = new CorosProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("coros.com");
  });

  it("throws when env vars are missing", () => {
    delete process.env.COROS_CLIENT_ID;
    delete process.env.COROS_CLIENT_SECRET;
    const provider = new CorosProvider();
    expect(() => provider.authSetup()).toThrow("COROS_CLIENT_ID");
  });
});

// ============================================================
// Cycling Analytics
// ============================================================

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
    expect(config?.scopes).toEqual([]);
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
    expect(config?.redirectUri).toContain("localhost");
  });
});

describe("CyclingAnalyticsProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when CYCLING_ANALYTICS_CLIENT_ID is missing", () => {
    delete process.env.CYCLING_ANALYTICS_CLIENT_ID;
    delete process.env.CYCLING_ANALYTICS_CLIENT_SECRET;
    const provider = new CyclingAnalyticsProvider();
    expect(provider.validate()).toContain("CYCLING_ANALYTICS_CLIENT_ID");
  });

  it("returns error when CYCLING_ANALYTICS_CLIENT_SECRET is missing", () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    delete process.env.CYCLING_ANALYTICS_CLIENT_SECRET;
    const provider = new CyclingAnalyticsProvider();
    expect(provider.validate()).toContain("CYCLING_ANALYTICS_CLIENT_SECRET");
  });

  it("returns null when both are set", () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";
    const provider = new CyclingAnalyticsProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("CyclingAnalyticsProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";
    const provider = new CyclingAnalyticsProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("cyclinganalytics.com");
  });

  it("throws when env vars are missing", () => {
    delete process.env.CYCLING_ANALYTICS_CLIENT_ID;
    delete process.env.CYCLING_ANALYTICS_CLIENT_SECRET;
    const provider = new CyclingAnalyticsProvider();
    expect(() => provider.authSetup()).toThrow("CYCLING_ANALYTICS_CLIENT_ID");
  });
});

// ============================================================
// Decathlon
// ============================================================

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

// ============================================================
// Komoot
// ============================================================

describe("komootOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when KOMOOT_CLIENT_ID is not set", () => {
    delete process.env.KOMOOT_CLIENT_ID;
    delete process.env.KOMOOT_CLIENT_SECRET;
    expect(komootOAuthConfig()).toBeNull();
  });

  it("returns null when KOMOOT_CLIENT_SECRET is not set", () => {
    process.env.KOMOOT_CLIENT_ID = "test-id";
    delete process.env.KOMOOT_CLIENT_SECRET;
    expect(komootOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.KOMOOT_CLIENT_ID = "test-id";
    process.env.KOMOOT_CLIENT_SECRET = "test-secret";
    const config = komootOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("profile");
    expect(config?.tokenAuthMethod).toBe("basic");
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
    expect(config?.redirectUri).toContain("localhost");
  });
});

describe("KomootProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when KOMOOT_CLIENT_ID is missing", () => {
    delete process.env.KOMOOT_CLIENT_ID;
    delete process.env.KOMOOT_CLIENT_SECRET;
    const provider = new KomootProvider();
    expect(provider.validate()).toContain("KOMOOT_CLIENT_ID");
  });

  it("returns error when KOMOOT_CLIENT_SECRET is missing", () => {
    process.env.KOMOOT_CLIENT_ID = "test-id";
    delete process.env.KOMOOT_CLIENT_SECRET;
    const provider = new KomootProvider();
    expect(provider.validate()).toContain("KOMOOT_CLIENT_SECRET");
  });

  it("returns null when both are set", () => {
    process.env.KOMOOT_CLIENT_ID = "test-id";
    process.env.KOMOOT_CLIENT_SECRET = "test-secret";
    const provider = new KomootProvider();
    expect(provider.validate()).toBeNull();
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
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("komoot.de");
  });

  it("throws when env vars are missing", () => {
    delete process.env.KOMOOT_CLIENT_ID;
    delete process.env.KOMOOT_CLIENT_SECRET;
    const provider = new KomootProvider();
    expect(() => provider.authSetup()).toThrow("KOMOOT_CLIENT_ID");
  });
});

// ============================================================
// Additional Komoot sport mappings not covered in new-providers.test.ts
// ============================================================

describe("mapKomootSport — additional mappings", () => {
  const { mapKomootSport } = require("../komoot.ts");

  it("maps e-bike variants to cycling", () => {
    expect(mapKomootSport("E_BIKING")).toBe("cycling");
    expect(mapKomootSport("ROAD_CYCLING")).toBe("cycling");
    expect(mapKomootSport("GRAVEL_BIKING")).toBe("cycling");
    expect(mapKomootSport("E_BIKE_TOURING")).toBe("cycling");
  });

  it("maps e-mountain biking", () => {
    expect(mapKomootSport("E_MT_BIKING")).toBe("mountain_biking");
  });

  it("maps winter sports", () => {
    expect(mapKomootSport("SKIING")).toBe("skiing");
    expect(mapKomootSport("CROSS_COUNTRY_SKIING")).toBe("cross_country_skiing");
    expect(mapKomootSport("SNOWSHOEING")).toBe("snowshoeing");
  });

  it("maps other outdoor activities", () => {
    expect(mapKomootSport("WALKING")).toBe("walking");
    expect(mapKomootSport("CLIMBING")).toBe("climbing");
    expect(mapKomootSport("PADDLING")).toBe("paddling");
    expect(mapKomootSport("INLINE_SKATING")).toBe("skating");
  });
});

// ============================================================
// Additional Decathlon sport mappings not covered in batch3-providers.test.ts
// ============================================================

describe("mapDecathlonSport — additional mappings", () => {
  const { mapDecathlonSport } = require("../decathlon.ts");

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

// ============================================================
// Additional COROS sport mappings not covered in new-providers.test.ts
// ============================================================

describe("mapCorosSportType — additional mappings", () => {
  const { mapCorosSportType } = require("../coros.ts");

  it("maps walking and hiking", () => {
    expect(mapCorosSportType(14)).toBe("walking");
    expect(mapCorosSportType(15)).toBe("hiking");
  });

  it("maps rowing and yoga", () => {
    expect(mapCorosSportType(17)).toBe("rowing");
    expect(mapCorosSportType(18)).toBe("yoga");
  });

  it("maps trail running and skiing", () => {
    expect(mapCorosSportType(22)).toBe("trail_running");
    expect(mapCorosSportType(23)).toBe("skiing");
  });

  it("maps triathlon", () => {
    expect(mapCorosSportType(27)).toBe("triathlon");
  });

  it("maps explicit other (100)", () => {
    expect(mapCorosSportType(100)).toBe("other");
  });
});

// ============================================================
// Additional Concept2 type mappings — case insensitivity
// ============================================================

describe("mapConcept2Type — case insensitivity", () => {
  const { mapConcept2Type } = require("../concept2.ts");

  it("handles uppercase input", () => {
    expect(mapConcept2Type("ROWER")).toBe("rowing");
    expect(mapConcept2Type("SKIERG")).toBe("skiing");
    expect(mapConcept2Type("BIKERG")).toBe("cycling");
  });

  it("handles mixed case input", () => {
    expect(mapConcept2Type("Rower")).toBe("rowing");
    expect(mapConcept2Type("SkiErg")).toBe("skiing");
    expect(mapConcept2Type("BikeRg")).toBe("cycling");
  });
});

// ============================================================
// Decathlon parseDecathlonActivity — edge case: empty dataSummaries
// ============================================================

describe("parseDecathlonActivity — edge cases", () => {
  const { parseDecathlonActivity } = require("../decathlon.ts");

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
