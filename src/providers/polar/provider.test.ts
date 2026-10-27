import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenSet } from "../../auth/oauth.ts";
import { logger } from "../../logger.ts";
import { PolarProvider } from "./provider.ts";

async function expectProviderRateLimitError(
  action: () => Promise<unknown>,
  providerId: string,
  retryAfterSeconds: number,
) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toMatchObject({ providerId, retryAfterSeconds });
    return;
  }

  throw new Error("Expected provider rate-limit error");
}

// ============================================================
// PolarProvider auth setup
// ============================================================

describe("PolarProvider.authSetup", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("throws when only POLAR_CLIENT_ID is set", () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    delete process.env.POLAR_CLIENT_SECRET;

    const provider = new PolarProvider();
    expect(() => provider.authSetup()).toThrow(
      "POLAR_CLIENT_ID and POLAR_CLIENT_SECRET are required",
    );
  });

  it("throws when only POLAR_CLIENT_SECRET is set", () => {
    delete process.env.POLAR_CLIENT_ID;
    process.env.POLAR_CLIENT_SECRET = "polar-secret";

    const provider = new PolarProvider();
    expect(() => provider.authSetup()).toThrow(
      "POLAR_CLIENT_ID and POLAR_CLIENT_SECRET are required",
    );
  });

  it("returns expected OAuth config fields for Polar", () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";

    const provider = new PolarProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig?.scopes).toEqual(["accesslink.read_all"]);
    expect(setup.oauthConfig?.tokenAuthMethod).toBe("basic");
  });

  it("registerWebhook throws the common rate-limit error when Polar throttles", async () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("try later", { status: 429, headers: { "Retry-After": "75" } });

    const provider = new PolarProvider(fetchFn);

    await expectProviderRateLimitError(
      () => provider.registerWebhook("https://dofek.example.com/webhook", "verify-token"),
      "polar",
      75,
    );
  });

  it("exchangeCode uses x_user_id from token response to register with AccessLink", async () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";

    const calledUrls: string[] = [];
    const registrationBodies: unknown[] = [];
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlString = String(url);
      calledUrls.push(`${init?.method ?? "GET"} ${urlString}`);

      // Token exchange — includes x_user_id
      if (urlString.startsWith("https://polarremote.com/")) {
        return Response.json({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
          x_user_id: 99887766,
        });
      }

      // POST /v3/users — register user
      if (urlString.endsWith("/v3/users") && init?.method === "POST") {
        if (init.body) registrationBodies.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 200 });
      }

      return Response.json([]);
    };

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    const { exchangeCode } = setup;
    if (!exchangeCode) throw new Error("exchangeCode not defined");
    const tokens = await exchangeCode("oauth-code");

    expect(tokens.accessToken).toBe("new-access-token");
    expect(tokens.providerAccountId).toBe("99887766");
    // Should register using x_user_id, not by calling GET /v3/users
    expect(calledUrls).toContain("POST https://www.polaraccesslink.com/v3/users");
    expect(calledUrls).not.toContain("GET https://www.polaraccesslink.com/v3/users");
    expect(registrationBodies[0]).toEqual({ "member-id": "99887766" });
  });

  it("exchangeCode throws when registration fails", async () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";

    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlString = String(url);
      if (urlString.startsWith("https://polarremote.com/")) {
        return Response.json({
          access_token: "new-access-token",
          expires_in: 3600,
          x_user_id: 12345,
        });
      }
      // POST /v3/users — registration fails
      if (urlString.endsWith("/v3/users") && init?.method === "POST") {
        return new Response("Server Error", { status: 500 });
      }
      return Response.json([]);
    };

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    await expect(setup.exchangeCode?.("oauth-code")).rejects.toThrow("registration failed");
  });

  it("exchangeCode throws when token response is missing x_user_id", async () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";

    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const urlString = String(url);
      if (urlString.startsWith("https://polarremote.com/")) {
        return Response.json({
          access_token: "new-access-token",
          expires_in: 3600,
          // No x_user_id
        });
      }
      return Response.json([]);
    };

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    await expect(setup.exchangeCode?.("oauth-code")).rejects.toThrow("missing x_user_id");
  });

  it("revokeExistingTokens deregisters user to free token slot", async () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";

    const calledUrls: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlString = String(url);
      calledUrls.push(`${init?.method ?? "GET"} ${urlString}`);

      // GET /v3/users — discover user ID
      if (urlString.endsWith("/v3/users") && (!init?.method || init.method === "GET")) {
        return Response.json({ polar_user_id: 12345 });
      }

      // DELETE /v3/users/12345 — deregister
      if (urlString.includes("/v3/users/12345") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }

      return Response.json([]);
    };

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.revokeExistingTokens) {
      throw new Error("Expected revokeExistingTokens to be defined");
    }

    await setup.revokeExistingTokens({
      accessToken: "old-access-token",
      refreshToken: null,
      expiresAt: new Date("2027-01-01"),
      providerAccountId: "12345",
      scopes: "accesslink.read_all",
    });

    expect(calledUrls).toContain("DELETE https://www.polaraccesslink.com/v3/users/12345");
    expect(calledUrls).not.toContain("GET https://www.polaraccesslink.com/v3/users");
  });

  it("does not weaken reconnect semantics when Polar reports an invalid token", async () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Bearer realm="polar", error="invalid_token"',
        },
      });
    };

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.revokeExistingTokens) {
      throw new Error("Expected revokeExistingTokens to be defined");
    }

    await expect(
      setup.revokeExistingTokens({
        accessToken: "dead-token",
        refreshToken: null,
        expiresAt: new Date("2020-01-01"),
        providerAccountId: "12345",
        scopes: null,
      }),
    ).rejects.toThrow("deregistration failed (401)");
  });
});

// ============================================================
// PolarProvider — exchangeCode AccessLink registration
// ============================================================

describe("PolarProvider — exchangeCode AccessLink registration", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("registers user with AccessLink on exchangeCode", async () => {
    process.env.POLAR_CLIENT_ID = "test-id";
    process.env.POLAR_CLIENT_SECRET = "test-secret";

    const fetchCalls: { url: string; method: string }[] = [];
    const mockFetch: typeof globalThis.fetch = vi.fn(async (url, init) => {
      const urlStr = String(url);
      const method = init?.method ?? "GET";
      fetchCalls.push({ url: urlStr, method });

      // Token exchange
      if (urlStr.includes("oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "new-token",
            refresh_token: "new-refresh",
            expires_in: 31536000,
            x_user_id: "123",
            scope: "accesslink.read_all",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Register (POST /v3/users)
      if (urlStr.includes("/v3/users") && method === "POST") {
        return new Response(null, { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    });

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    const { exchangeCode } = setup;
    if (!exchangeCode) throw new Error("exchangeCode not defined");
    const tokens = await exchangeCode("auth-code");

    expect(tokens.accessToken).toBe("new-token");

    // Verify register was called
    const registerCall = fetchCalls.find(
      (call) => call.method === "POST" && call.url.includes("/v3/users"),
    );
    expect(registerCall).toBeDefined();

    // Verify no deregister was called (deregistration belongs in revokeExistingTokens)
    const deregisterCall = fetchCalls.find(
      (call) => call.method === "DELETE" && call.url.includes("/v3/users/"),
    );
    expect(deregisterCall).toBeUndefined();
  });

  it("throws when AccessLink registration fails with non-409 error", async () => {
    process.env.POLAR_CLIENT_ID = "test-id";
    process.env.POLAR_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = vi.fn(async (url, init) => {
      const urlStr = String(url);

      if (urlStr.includes("oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "new-token",
            x_user_id: "123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Register fails with 500
      if (init?.method === "POST" && urlStr.includes("/v3/users")) {
        return new Response("Internal Server Error", { status: 500 });
      }

      return new Response("Not found", { status: 404 });
    });

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    const { exchangeCode } = setup;
    if (!exchangeCode) throw new Error("exchangeCode not defined");
    await expect(exchangeCode("auth-code")).rejects.toThrow("registration failed");
  });

  it("succeeds when registration returns 409 (already registered)", async () => {
    process.env.POLAR_CLIENT_ID = "test-id";
    process.env.POLAR_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = vi.fn(async (url, init) => {
      const urlStr = String(url);

      if (urlStr.includes("oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "new-token",
            x_user_id: "123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // 409 = already registered — should succeed
      if (init?.method === "POST" && urlStr.includes("/v3/users")) {
        return new Response(null, { status: 409 });
      }

      return new Response("Not found", { status: 404 });
    });

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    const { exchangeCode } = setup;
    if (!exchangeCode) throw new Error("exchangeCode not defined");
    const tokens = await exchangeCode("auth-code");
    expect(tokens.accessToken).toBe("new-token");
  });
});

// ============================================================
// PolarProvider — exchangeCode token request & parsing
// ============================================================

describe("PolarProvider — exchangeCode token request & parsing", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function setupProvider(tokenBody: Record<string, unknown>, tokenStatus = 200) {
    process.env.POLAR_CLIENT_ID = "client-id";
    process.env.POLAR_CLIENT_SECRET = "client-secret";

    const tokenRequest: { method?: string; headers: Headers; body: string } = {
      headers: new Headers(),
      body: "",
    };
    const mockFetch: typeof globalThis.fetch = vi.fn(async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes("oauth2/token")) {
        tokenRequest.method = init?.method;
        tokenRequest.headers = new Headers(init?.headers);
        tokenRequest.body = String(init?.body ?? "");
        if (tokenStatus !== 200) {
          return new Response("bad request", { status: tokenStatus });
        }
        return new Response(JSON.stringify(tokenBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (urlStr.includes("/v3/users") && init?.method === "POST") {
        return new Response(null, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    return { provider: new PolarProvider(mockFetch), tokenRequest };
  }

  it("posts a form-encoded body with basic auth and the auth code", async () => {
    const { provider, tokenRequest } = setupProvider({
      access_token: "tok",
      x_user_id: "1",
    });

    await provider.authSetup().exchangeCode?.("the-auth-code");

    expect(tokenRequest.method).toBe("POST");
    expect(tokenRequest.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(tokenRequest.headers.get("Authorization")).toBe(
      `Basic ${btoa("client-id:client-secret")}`,
    );
    const params = new URLSearchParams(tokenRequest.body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("the-auth-code");
    expect(params.get("redirect_uri")).toBeTruthy();
  });

  it("throws when the token exchange response is not ok", async () => {
    const { provider } = setupProvider({}, 400);
    await expect(provider.authSetup().exchangeCode?.("c")).rejects.toThrow(
      "Polar token exchange failed",
    );
  });

  it("uses provider-supplied expires_in, refresh_token, and scope", async () => {
    const before = Date.now();
    const { provider } = setupProvider({
      access_token: "tok",
      x_user_id: "1",
      expires_in: 3600,
      refresh_token: "refresh-tok",
      scope: "accesslink.read_all",
    });

    const { exchangeCode } = provider.authSetup();
    if (!exchangeCode) throw new Error("exchangeCode not defined");
    const tokens = await exchangeCode("c");

    expect(tokens.refreshToken).toBe("refresh-tok");
    expect(tokens.scopes).toBe("accesslink.read_all");
    const elapsedToExpiry = tokens.expiresAt.getTime() - before;
    expect(elapsedToExpiry).toBeGreaterThan(3500 * 1000);
    expect(elapsedToExpiry).toBeLessThan(3700 * 1000);
  });

  it("falls back to one-year expiry and null refresh/scope when omitted", async () => {
    const before = Date.now();
    const { provider } = setupProvider({
      access_token: "tok",
      x_user_id: "1",
    });

    const { exchangeCode } = provider.authSetup();
    if (!exchangeCode) throw new Error("exchangeCode not defined");
    const tokens = await exchangeCode("c");

    expect(tokens.refreshToken).toBeNull();
    expect(tokens.scopes).toBeNull();
    const daysToExpiry = (tokens.expiresAt.getTime() - before) / (1000 * 60 * 60 * 24);
    expect(daysToExpiry).toBeGreaterThan(364);
    expect(daysToExpiry).toBeLessThan(366);
  });
});

// ============================================================
// PolarProvider — revokeExistingTokens
// ============================================================

describe("PolarProvider — revokeExistingTokens", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  const oldTokens: TokenSet = {
    accessToken: "old-token",
    refreshToken: null,
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: null,
  };

  it("deregisters the discovered user to revoke the old token", async () => {
    process.env.POLAR_CLIENT_ID = "client-id";
    process.env.POLAR_CLIENT_SECRET = "client-secret";
    const deletedIds: string[] = [];

    const mockFetch: typeof globalThis.fetch = vi.fn(async (url, init) => {
      const urlStr = String(url);
      const method = init?.method ?? "GET";
      if (urlStr.endsWith("/v3/users") && method === "GET") {
        return new Response(JSON.stringify({ polar_user_id: "old-user-9" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "DELETE" && urlStr.includes("/v3/users/")) {
        deletedIds.push(urlStr.split("/v3/users/")[1] ?? "");
        return new Response(null, { status: 204 });
      }
      return new Response("Not found", { status: 404 });
    });

    const provider = new PolarProvider(mockFetch);
    const revoke = provider.authSetup().revokeExistingTokens;
    if (!revoke) throw new Error("expected revokeExistingTokens");
    await revoke(oldTokens);

    expect(deletedIds).toEqual(["old-user-9"]);
  });

  it("rejects and does not deregister when the user id cannot be discovered", async () => {
    process.env.POLAR_CLIENT_ID = "client-id";
    process.env.POLAR_CLIENT_SECRET = "client-secret";
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    let deleteCalled = false;

    const mockFetch: typeof globalThis.fetch = vi.fn(async (url, init) => {
      const urlStr = String(url);
      const method = init?.method ?? "GET";
      if (urlStr.endsWith("/v3/users") && method === "GET") {
        // No polar_user_id → getCurrentUserId resolves null
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "DELETE") {
        deleteCalled = true;
        return new Response(null, { status: 204 });
      }
      return new Response("Not found", { status: 404 });
    });

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    expect(setup.reconnectStrategy).toBe("revoke-then-replace");
    const revoke = setup.revokeExistingTokens;
    if (!revoke) throw new Error("expected revokeExistingTokens");
    await expect(revoke(oldTokens)).rejects.toThrow("not confirmed revoked");

    expect(deleteCalled).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Token revocation failed"));
  });
});

// ============================================================
// PolarProvider — validate and properties
// ============================================================

describe("PolarProvider — validate and properties", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("has correct id and name", () => {
    const provider = new PolarProvider();
    expect(provider.id).toBe("polar");
    expect(provider.name).toBe("Polar");
  });

  it("returns error when POLAR_CLIENT_ID is missing", () => {
    delete process.env.POLAR_CLIENT_ID;
    delete process.env.POLAR_CLIENT_SECRET;
    const provider = new PolarProvider();
    expect(provider.validate()).toContain("POLAR_CLIENT_ID");
  });

  it("returns error when POLAR_CLIENT_SECRET is missing", () => {
    process.env.POLAR_CLIENT_ID = "test-id";
    delete process.env.POLAR_CLIENT_SECRET;
    const provider = new PolarProvider();
    expect(provider.validate()).toContain("POLAR_CLIENT_SECRET");
  });

  it("returns null when both env vars are set", () => {
    process.env.POLAR_CLIENT_ID = "test-id";
    process.env.POLAR_CLIENT_SECRET = "test-secret";
    const provider = new PolarProvider();
    expect(provider.validate()).toBeNull();
  });

  it("authSetup returns correct config", () => {
    process.env.POLAR_CLIENT_ID = "test-id";
    process.env.POLAR_CLIENT_SECRET = "test-secret";
    const provider = new PolarProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig?.clientId).toBe("test-id");
    expect(setup.oauthConfig?.clientSecret).toBe("test-secret");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("polaraccesslink.com");
  });

  it("authSetup throws when env vars missing", () => {
    delete process.env.POLAR_CLIENT_ID;
    delete process.env.POLAR_CLIENT_SECRET;
    const provider = new PolarProvider();
    expect(() => provider.authSetup()).toThrow("POLAR_CLIENT_ID");
  });
});
