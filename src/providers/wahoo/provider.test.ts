import { afterEach, describe, expect, it } from "vitest";
import { wahooOAuthConfig } from "./provider.ts";

describe("wahooOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when credentials are missing", () => {
    delete process.env.WAHOO_CLIENT_ID;
    delete process.env.WAHOO_CLIENT_SECRET;
    expect(wahooOAuthConfig()).toBeNull();
  });

  it("returns config with correct URLs when credentials are set", () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";
    const config = wahooOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.authorizeUrl).toBe("https://api.wahooligan.com/oauth/authorize");
    expect(config?.tokenUrl).toBe("https://api.wahooligan.com/oauth/token");
  });

  it("includes revokeUrl for Doorkeeper token revocation", () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";
    const config = wahooOAuthConfig();
    expect(config?.revokeUrl).toBe("https://api.wahooligan.com/oauth/revoke");
  });

  it("uses dynamic redirect URI based on host", () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";
    const config = wahooOAuthConfig("dofek.asherlc.com");
    expect(config?.redirectUri).toBe("https://dofek.asherlc.com/callback");
  });
});
