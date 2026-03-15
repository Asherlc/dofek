import { afterEach, describe, expect, it } from "vitest";
import { KomootProvider, komootOAuthConfig, mapKomootSport } from "./komoot.ts";

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

describe("mapKomootSport — additional mappings", () => {
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
