import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { WAHOO_API_BASE } from "./client.ts";
import { WahooProvider, wahooOAuthConfig } from "./provider.ts";

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

describe("WahooProvider.authSetup.revokeExistingTokens", () => {
  const originalEnv = { ...process.env };
  const server = setupServer();

  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => {
    server.resetHandlers();
    process.env = { ...originalEnv };
  });
  afterAll(() => server.close());

  function setupEnv() {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";
  }

  const expiredTokens = {
    accessToken: "expired-access",
    refreshToken: "valid-refresh",
    expiresAt: new Date("2020-01-01"),
    scopes: null,
  };

  const validTokens = {
    accessToken: "valid-access",
    refreshToken: "valid-refresh",
    expiresAt: new Date("2030-01-01"),
    scopes: null,
  };

  function getRevokeExistingTokens() {
    const provider = new WahooProvider();
    const setup = provider.authSetup();
    if (!setup.revokeExistingTokens) {
      throw new Error("revokeExistingTokens should be defined for Wahoo");
    }
    return setup.revokeExistingTokens;
  }

  it("revokes with stored access token when it is valid", async () => {
    setupEnv();
    let revokeCalled = false;
    server.use(
      http.delete(`${WAHOO_API_BASE}/v1/permissions`, () => {
        revokeCalled = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const revokeExistingTokens = getRevokeExistingTokens();
    await revokeExistingTokens(validTokens);
    expect(revokeCalled).toBe(true);
  });

  it("refreshes token and revokes when access token is expired", async () => {
    setupEnv();
    let deleteCallCount = 0;
    let refreshCalled = false;

    server.use(
      http.delete(`${WAHOO_API_BASE}/v1/permissions`, ({ request }) => {
        deleteCallCount++;
        const authHeader = request.headers.get("Authorization");
        // First call with expired token fails
        if (authHeader === "Bearer expired-access") {
          return HttpResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        // Second call with refreshed token succeeds
        if (authHeader === "Bearer refreshed-access") {
          return new HttpResponse(null, { status: 204 });
        }
        return HttpResponse.json({ error: "Unexpected token" }, { status: 401 });
      }),
      http.post(`${WAHOO_API_BASE}/oauth/token`, async ({ request }) => {
        const body = await request.text();
        const params = new URLSearchParams(body);
        if (params.get("grant_type") === "refresh_token") {
          refreshCalled = true;
          return HttpResponse.json({
            access_token: "refreshed-access",
            refresh_token: "new-refresh",
            expires_in: 7200,
          });
        }
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      }),
    );

    const revokeExistingTokens = getRevokeExistingTokens();
    await revokeExistingTokens(expiredTokens);
    expect(refreshCalled).toBe(true);
    expect(deleteCallCount).toBe(2);
  });

  it("rethrows non-auth errors without attempting refresh", async () => {
    setupEnv();
    let refreshCalled = false;
    server.use(
      http.delete(`${WAHOO_API_BASE}/v1/permissions`, () => {
        return HttpResponse.json({ error: "Rate limited" }, { status: 429 });
      }),
      http.post(`${WAHOO_API_BASE}/oauth/token`, () => {
        refreshCalled = true;
        return HttpResponse.json({ access_token: "new", expires_in: 7200 });
      }),
    );

    const revokeExistingTokens = getRevokeExistingTokens();
    await expect(revokeExistingTokens(validTokens)).rejects.toThrow("429");
    expect(refreshCalled).toBe(false);
  });

  it("throws when access token is expired and no refresh token", async () => {
    setupEnv();
    server.use(
      http.delete(`${WAHOO_API_BASE}/v1/permissions`, () => {
        return HttpResponse.json({ error: "Unauthorized" }, { status: 401 });
      }),
    );

    const revokeExistingTokens = getRevokeExistingTokens();
    await expect(revokeExistingTokens({ ...expiredTokens, refreshToken: null })).rejects.toThrow(
      "Cannot revoke Wahoo tokens",
    );
  });
});
