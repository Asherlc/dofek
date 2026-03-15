import { afterEach, describe, expect, it } from "vitest";
import { CorosProvider, corosOAuthConfig, mapCorosSportType } from "./coros.ts";

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

describe("mapCorosSportType — additional mappings", () => {
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
