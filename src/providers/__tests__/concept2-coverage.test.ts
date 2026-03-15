import { afterEach, describe, expect, it } from "vitest";
import { Concept2Provider, concept2OAuthConfig, mapConcept2Type } from "../concept2.ts";

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

describe("mapConcept2Type — case insensitivity", () => {
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
