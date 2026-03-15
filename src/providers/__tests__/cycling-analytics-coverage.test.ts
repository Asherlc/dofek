import { afterEach, describe, expect, it } from "vitest";
import { CyclingAnalyticsProvider, cyclingAnalyticsOAuthConfig } from "../cycling-analytics.ts";

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
