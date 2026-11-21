import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthorizationUrl, type TokenSet } from "../../auth/oauth.ts";
import { ProviderPartialGrantError } from "../auth-errors.ts";
import type { ProviderAuthSetup } from "../types.ts";
import { createIntervalsIcuAuthSetup, validateIntervalsIcuConfig } from "./oauth.ts";

const AUTHORIZE_URL = "https://intervals.icu/oauth/authorize";
const TOKEN_URL = "https://intervals.icu/api/oauth/token";
const API_BASE = "https://intervals.icu/api/v1";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function requireAuthSetup(options?: { host?: string }): ProviderAuthSetup {
  const setup = createIntervalsIcuAuthSetup(options);
  expect(setup).toBeDefined();
  if (!setup) throw new Error("Expected auth setup to be defined");
  return setup;
}

function requireExchangeCode(setup: ProviderAuthSetup) {
  const exchangeCode = setup.exchangeCode;
  expect(exchangeCode).toBeDefined();
  if (!exchangeCode) throw new Error("Expected exchangeCode to be defined");
  return exchangeCode;
}

function requireRevokeTokens(setup: ProviderAuthSetup) {
  const revoke = setup.revokeExistingTokens;
  expect(revoke).toBeDefined();
  if (!revoke) throw new Error("Expected revokeExistingTokens to be defined");
  return revoke;
}

function requireErasureRevokeTokens(setup: ProviderAuthSetup) {
  const revoke = setup.revokeTokensForAccountErasure;
  expect(revoke).toBeDefined();
  if (!revoke) throw new Error("Expected revokeTokensForAccountErasure to be defined");
  return revoke;
}

describe("validateIntervalsIcuConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns an error string when both credentials are missing", () => {
    delete process.env.INTERVALS_ICU_CLIENT_ID;
    delete process.env.INTERVALS_ICU_CLIENT_SECRET;
    expect(validateIntervalsIcuConfig()).toBe(
      "Missing INTERVALS_ICU_CLIENT_ID or INTERVALS_ICU_CLIENT_SECRET",
    );
  });

  it("returns an error string when client ID is missing", () => {
    delete process.env.INTERVALS_ICU_CLIENT_ID;
    process.env.INTERVALS_ICU_CLIENT_SECRET = "secret-123";
    expect(validateIntervalsIcuConfig()).toBe(
      "Missing INTERVALS_ICU_CLIENT_ID or INTERVALS_ICU_CLIENT_SECRET",
    );
  });

  it("returns an error string when client secret is missing", () => {
    process.env.INTERVALS_ICU_CLIENT_ID = "client-123";
    delete process.env.INTERVALS_ICU_CLIENT_SECRET;
    expect(validateIntervalsIcuConfig()).toBe(
      "Missing INTERVALS_ICU_CLIENT_ID or INTERVALS_ICU_CLIENT_SECRET",
    );
  });

  it("returns null when both credentials are present", () => {
    process.env.INTERVALS_ICU_CLIENT_ID = "client-123";
    process.env.INTERVALS_ICU_CLIENT_SECRET = "secret-123";
    expect(validateIntervalsIcuConfig()).toBeNull();
  });
});

describe("createIntervalsIcuAuthSetup", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns a minimal revocation-only setup when app credentials are missing", () => {
    delete process.env.INTERVALS_ICU_CLIENT_ID;
    delete process.env.INTERVALS_ICU_CLIENT_SECRET;

    const setup = createIntervalsIcuAuthSetup();
    expect(setup).toBeDefined();
    if (!setup) throw new Error("Expected auth setup to be defined");

    // No OAuth connect flow when credentials are unconfigured.
    expect(setup.oauthConfig).toBeUndefined();
    expect(setup.exchangeCode).toBeUndefined();

    // Revocation-only hooks remain available (use saved bearer tokens).
    expect(setup.revokeExistingTokens).toBeTypeOf("function");
    expect(setup.revokeTokensForAccountErasure).toBeTypeOf("function");
  });

  it("configures OAuth endpoints, S256 PKCE, comma-separated scopes, and replace strategy", () => {
    process.env.INTERVALS_ICU_CLIENT_ID = "test-client-id";
    process.env.INTERVALS_ICU_CLIENT_SECRET = "test-client-secret";

    const setup = requireAuthSetup({ host: "dofek.test" });
    expect(setup.reconnectStrategy).toBe("replace");
    expect(setup.apiBaseUrl).toBe(API_BASE);

    const oauthConfig = setup.oauthConfig;
    expect(oauthConfig).toBeDefined();
    if (!oauthConfig) throw new Error("Expected oauthConfig to be defined");
    expect(oauthConfig.clientId).toBe("test-client-id");
    expect(oauthConfig.clientSecret).toBe("test-client-secret");
    expect(oauthConfig.authorizeUrl).toBe(AUTHORIZE_URL);
    expect(oauthConfig.tokenUrl).toBe(TOKEN_URL);
    expect(oauthConfig.redirectUri).toBe("https://dofek.test/callback");
    expect(oauthConfig.scopes).toEqual(["ACTIVITY:READ", "WELLNESS:READ", "CALENDAR:READ"]);
    expect(oauthConfig.scopeSeparator).toBe(",");
    expect(oauthConfig.usePkce).toBe(true);

    const authUrl = buildAuthorizationUrl(oauthConfig, { codeChallenge: "s256-test-challenge" });
    const parsed = new URL(authUrl);
    expect(parsed.origin + parsed.pathname).toBe(AUTHORIZE_URL);
    expect(parsed.searchParams.get("client_id")).toBe("test-client-id");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://dofek.test/callback");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("scope")).toBe("ACTIVITY:READ,WELLNESS:READ,CALENDAR:READ");
    expect(parsed.searchParams.get("code_challenge")).toBe("s256-test-challenge");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("Intervals.icu OAuth exchangeCode", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.INTERVALS_ICU_CLIENT_ID = "intervals-client-id";
    process.env.INTERVALS_ICU_CLIENT_SECRET = "intervals-client-secret";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("posts exact vendor form fields (client_id, client_secret, code, code_verifier) and extracts athlete ID and scopes", async () => {
    let capturedBody: string | null = null;
    let capturedContentType: string | null = null;

    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        capturedContentType = request.headers.get("content-type");
        capturedBody = await request.text();
        return HttpResponse.json({
          token_type: "Bearer",
          access_token: "icu-secret-access-token",
          scope: "ACTIVITY:READ,WELLNESS:READ,CALENDAR:READ",
          athlete: {
            id: "i2049151",
            name: "Test Athlete",
          },
        });
      }),
    );

    const setup = requireAuthSetup();
    const exchangeCode = requireExchangeCode(setup);
    const onTokensIssued = vi.fn();

    const tokens = await exchangeCode(
      "test-auth-code",
      "test-pkce-code-verifier-s256",
      onTokensIssued,
    );

    expect(capturedContentType).toBe("application/x-www-form-urlencoded");
    expect(capturedBody).toBeDefined();
    const params = new URLSearchParams(capturedBody ?? "");
    expect(params.get("client_id")).toBe("intervals-client-id");
    expect(params.get("client_secret")).toBe("intervals-client-secret");
    expect(params.get("code")).toBe("test-auth-code");
    expect(params.get("code_verifier")).toBe("test-pkce-code-verifier-s256");
    expect(params.get("grant_type")).toBeNull();
    expect(params.get("redirect_uri")).toBeNull();

    expect(tokens).toEqual({
      accessToken: "icu-secret-access-token",
      refreshToken: null,
      expiresAt: expect.any(Date),
      scopes: "ACTIVITY:READ,WELLNESS:READ,CALENDAR:READ",
      providerAccountId: "i2049151",
    });
    // Conservative default expiry is ~1 year in the future
    const oneYearFromNow = Date.now() + 365 * 24 * 60 * 60 * 1000;
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(oneYearFromNow - 60_000);
    expect(tokens.expiresAt.getTime()).toBeLessThan(oneYearFromNow + 60_000);

    expect(onTokensIssued).toHaveBeenCalledWith(tokens);
  });

  it("handles numeric athlete ID by normalizing to string", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          token_type: "Bearer",
          access_token: "icu-token",
          scope: "ACTIVITY:READ,WELLNESS:READ,CALENDAR:READ",
          athlete: {
            id: 2049151,
            name: "Test Athlete",
          },
        });
      }),
    );

    const setup = requireAuthSetup();
    const exchangeCode = requireExchangeCode(setup);
    const tokens = await exchangeCode("code", "verifier");
    expect(tokens.providerAccountId).toBe("2049151");
  });

  it("rejects when PKCE code verifier is missing or blank", async () => {
    const setup = requireAuthSetup();
    const exchangeCode = requireExchangeCode(setup);
    await expect(exchangeCode("test-code", "")).rejects.toThrow(
      "Intervals.icu OAuth requires the original PKCE code verifier",
    );
    await expect(exchangeCode("test-code", undefined)).rejects.toThrow(
      "Intervals.icu OAuth requires the original PKCE code verifier",
    );
  });

  it("identifies missing scopes on partial grants and prompts user to reconnect", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          token_type: "Bearer",
          access_token: "secret-token",
          scope: "ACTIVITY:READ,WELLNESS:READ",
          athlete: { id: "i123" },
        });
      }),
    );

    const setup = requireAuthSetup();
    const exchangeCode = requireExchangeCode(setup);
    await expect(exchangeCode("code", "verifier")).rejects.toThrow(ProviderPartialGrantError);
    await expect(exchangeCode("code", "verifier")).rejects.toThrow(/Missing: CALENDAR:READ/);
  });

  it("identifies multiple missing scopes when only one grant was given", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          token_type: "Bearer",
          access_token: "secret-token",
          scope: "CALENDAR:READ",
          athlete: { id: "i123" },
        });
      }),
    );

    const setup = requireAuthSetup();
    const exchangeCode = requireExchangeCode(setup);
    await expect(exchangeCode("code", "verifier")).rejects.toThrow(
      /ACTIVITY:READ.*WELLNESS:READ|WELLNESS:READ.*ACTIVITY:READ/i,
    );
  });

  it("rejects malformed response missing access_token", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          scope: "ACTIVITY:READ,WELLNESS:READ,CALENDAR:READ",
          athlete: { id: "i123" },
        });
      }),
    );

    const setup = requireAuthSetup();
    const exchangeCode = requireExchangeCode(setup);
    await expect(exchangeCode("code", "verifier")).rejects.toThrow(
      "Intervals.icu returned a malformed token response",
    );
  });

  it("rejects malformed response missing athlete info", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "secret-token",
          scope: "ACTIVITY:READ,WELLNESS:READ,CALENDAR:READ",
        });
      }),
    );

    const setup = requireAuthSetup();
    const exchangeCode = requireExchangeCode(setup);
    await expect(exchangeCode("code", "verifier")).rejects.toThrow(
      "Intervals.icu token response is missing athlete information",
    );
  });

  it("keeps private response content out of errors on upstream HTTP failure", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return new HttpResponse(
          JSON.stringify({
            error: "invalid_grant",
            secret_internal_detail: "super-secret-user-email@example.com",
            private_token: "secret-token-leak",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const setup = requireAuthSetup();
    const exchangeCode = requireExchangeCode(setup);
    let error: Error | undefined;
    try {
      await exchangeCode("bad-code", "verifier");
    } catch (e) {
      if (e instanceof Error) error = e;
    }

    expect(error).toBeDefined();
    expect(error?.message).toBe("Intervals.icu token exchange failed (400)");
    expect(error?.message).not.toContain("super-secret");
    expect(error?.message).not.toContain("secret-token-leak");
  });
});

describe("Intervals.icu token revocation (disconnect & erasure)", () => {
  const originalEnv = { ...process.env };
  const mockTokens: TokenSet = {
    accessToken: "sensitive-athlete-token-xyz",
    refreshToken: null,
    expiresAt: new Date(Date.now() + 3600_000),
    scopes: "ACTIVITY:READ,WELLNESS:READ,CALENDAR:READ",
    providerAccountId: "i12345",
  };

  beforeEach(() => {
    process.env.INTERVALS_ICU_CLIENT_ID = "intervals-client-id";
    process.env.INTERVALS_ICU_CLIENT_SECRET = "intervals-client-secret";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("revokes saved bearer tokens for disconnect and erasure without app credentials", async () => {
    delete process.env.INTERVALS_ICU_CLIENT_ID;
    delete process.env.INTERVALS_ICU_CLIENT_SECRET;
    const authorizations: (string | null)[] = [];
    server.use(
      http.delete(`${API_BASE}/disconnect-app`, ({ request }) => {
        authorizations.push(request.headers.get("authorization"));
        return new HttpResponse(null, { status: 200 });
      }),
    );

    const setup = createIntervalsIcuAuthSetup();
    await requireRevokeTokens(setup)(mockTokens);
    await requireErasureRevokeTokens(setup)(mockTokens);

    expect(authorizations).toEqual([
      `Bearer ${mockTokens.accessToken}`,
      `Bearer ${mockTokens.accessToken}`,
    ]);
  });

  it("sends Bearer DELETE /api/v1/disconnect-app and succeeds on HTTP 200", async () => {
    let capturedAuth: string | null = null;

    server.use(
      http.delete(`${API_BASE}/disconnect-app`, ({ request }) => {
        capturedAuth = request.headers.get("authorization");
        return HttpResponse.json({ status: "ok" }, { status: 200 });
      }),
    );

    const setup = requireAuthSetup();
    const revoke = requireRevokeTokens(setup);
    const erasureRevoke = requireErasureRevokeTokens(setup);

    await revoke(mockTokens);
    expect(capturedAuth).toBe("Bearer sensitive-athlete-token-xyz");

    capturedAuth = null;
    await erasureRevoke(mockTokens);
    expect(capturedAuth).toBe("Bearer sensitive-athlete-token-xyz");
  });

  it("treats documented HTTP 401 as terminal already invalid without throwing", async () => {
    server.use(
      http.delete(`${API_BASE}/disconnect-app`, () => {
        return new HttpResponse("Missing or invalid access token", { status: 401 });
      }),
    );

    const setup = requireAuthSetup();
    const revoke = requireRevokeTokens(setup);
    const erasureRevoke = requireErasureRevokeTokens(setup);

    await expect(revoke(mockTokens)).resolves.toBeUndefined();
    await expect(erasureRevoke(mockTokens)).resolves.toBeUndefined();
  });

  it("preserves actionable failure (403, 404, 429, 500) for retry without leaking private data", async () => {
    for (const status of [201, 204, 403, 404, 429, 500]) {
      server.use(
        http.delete(`${API_BASE}/disconnect-app`, () => {
          if (status === 204) return new HttpResponse(null, { status });
          return new HttpResponse(
            JSON.stringify({ private_info: "sensitive-token-or-athlete-details" }),
            { status, headers: { "Content-Type": "application/json" } },
          );
        }),
      );

      const setup = requireAuthSetup();
      const revoke = requireRevokeTokens(setup);
      let error: Error | undefined;
      try {
        await revoke(mockTokens);
      } catch (e) {
        if (e instanceof Error) error = e;
      }

      expect(error).toBeDefined();
      expect(error?.message).toBe(`Intervals.icu disconnect failed (${status})`);
      expect(error?.message).not.toContain("sensitive");
    }
  });

  it("does not follow a redirect to a successful final response", async () => {
    server.use(
      http.delete(`${API_BASE}/disconnect-app`, () =>
        HttpResponse.redirect("https://intervals.icu/api/v1/final", 302),
      ),
      http.get("https://intervals.icu/api/v1/final", () => new HttpResponse("ok", { status: 200 })),
    );

    await expect(requireRevokeTokens(requireAuthSetup())(mockTokens)).rejects.toThrow();
  });
});
