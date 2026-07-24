import { createHash, randomBytes } from "node:crypto";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Database } from "dofek/db";
import { response as expressResponse, type Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DofekOAuthServerProvider,
  MCP_OAUTH_SCOPES,
  oauthAccessTokenName,
} from "./oauth-provider.ts";

const mocks = vi.hoisted(() => ({
  createAuthorizationCode: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  getAuthorizationCodeChallenge: vi.fn(),
  revokeOAuthToken: vi.fn(),
  rotateRefreshToken: vi.fn(),
  validateMcpToken: vi.fn(),
}));

vi.mock("./oauth-repository.ts", () => ({
  createAuthorizationCode: mocks.createAuthorizationCode,
  exchangeAuthorizationCode: mocks.exchangeAuthorizationCode,
  getAuthorizationCodeChallenge: mocks.getAuthorizationCodeChallenge,
  revokeOAuthToken: mocks.revokeOAuthToken,
  rotateRefreshToken: mocks.rotateRefreshToken,
}));

vi.mock("./token-repository.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./token-repository.ts")>();
  return { ...actual, validateMcpToken: mocks.validateMcpToken };
});

const resource = new URL("https://app.example.test/api/mcp");
const redirectUri = "https://claude.ai/api/mcp/auth_callback";

function makeClient(
  overrides: Partial<OAuthClientInformationFull> = {},
): OAuthClientInformationFull {
  return {
    client_id: `client_${randomBytes(4).toString("hex")}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: "Claude",
    client_secret: "secret_value",
    client_secret_expires_at: Math.floor(Date.now() / 1000) + 86400,
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: [redirectUri],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
    ...overrides,
  };
}

function makeParams(overrides: Partial<AuthorizationParams> = {}): AuthorizationParams {
  return {
    codeChallenge: "challenge-value",
    redirectUri,
    resource,
    ...overrides,
  };
}

interface ResponseMocks {
  redirect: ReturnType<typeof vi.fn<(location: string) => void>>;
  send: ReturnType<typeof vi.fn<(body: string) => void>>;
  type: ReturnType<typeof vi.fn<(type: string) => void>>;
}

function makeResponse(locals: Record<string, unknown> = {}): {
  response: Response;
  mocks: ResponseMocks;
} {
  const redirect = vi.fn<(location: string) => void>();
  const send = vi.fn<(body: string) => void>();
  const type = vi.fn<(type: string) => void>();
  const response: Response = Object.create(expressResponse);
  Object.assign(response, { locals, redirect, send, type });
  type.mockReturnValue(response);
  return {
    response,
    mocks: { redirect, send, type },
  };
}

function s256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

describe("oauthAccessTokenName", () => {
  it("prefers the registered client_name", () => {
    expect(oauthAccessTokenName(makeClient({ client_name: "Claude" }))).toBe("Claude OAuth");
    expect(oauthAccessTokenName(makeClient({ client_name: "ChatGPT" }))).toBe("ChatGPT OAuth");
  });

  it("trims whitespace from client_name", () => {
    expect(oauthAccessTokenName(makeClient({ client_name: "  Claude  " }))).toBe("Claude OAuth");
  });

  it("falls back to MCP OAuth when client_name is missing", () => {
    expect(oauthAccessTokenName(makeClient({ client_name: undefined }))).toBe("MCP OAuth");
  });
});

function mockDb(): Pick<Database, "execute"> {
  return { execute: vi.fn() };
}

function provider(): DofekOAuthServerProvider {
  return new DofekOAuthServerProvider(mockDb(), resource);
}

describe("DofekOAuthServerProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authorize", () => {
    it("rejects when the requested resource does not match the MCP server", async () => {
      const client = makeClient();
      const params = makeParams({ resource: new URL("https://other.example/api/mcp") });
      await expect(provider().authorize(client, params, makeResponse().response)).rejects.toThrow(
        InvalidTargetError,
      );
    });

    it("rejects when the resource parameter is missing", async () => {
      const client = makeClient();
      const params = makeParams({ resource: undefined });
      await expect(provider().authorize(client, params, makeResponse().response)).rejects.toThrow(
        InvalidTargetError,
      );
    });

    it("rejects unsupported scopes", async () => {
      const client = makeClient();
      const params = makeParams({ scopes: ["invalid:scope"] });
      await expect(
        provider().authorize(client, params, makeResponse({ mcpOAuthUserId: "user-1" }).response),
      ).rejects.toThrow(InvalidScopeError);
    });

    it("throws AccessDeniedError when the OAuth session context is missing", async () => {
      const client = makeClient();
      const params = makeParams();
      await expect(provider().authorize(client, params, makeResponse().response)).rejects.toThrow(
        AccessDeniedError,
      );
    });

    it("renders the consent form with hidden fields carrying every authorization parameter", async () => {
      const client = makeClient({ client_id: "client-abc", client_name: "Claude Desktop" });
      const verifier = randomBytes(32).toString("base64url");
      const params = makeParams({
        codeChallenge: s256(verifier),
        scopes: ["health:read", "activity:read"],
        state: "state-value",
      });
      const { response, mocks: responseMocks } = makeResponse({ mcpOAuthUserId: "user-1" });

      await provider().authorize(client, params, response);

      expect(responseMocks.type).toHaveBeenCalledWith("html");
      const html = responseMocks.send.mock.calls[0]?.[0] ?? "";
      expect(html).toContain("Allow Claude Desktop to access Dofek?");
      for (const field of [
        "client_id",
        "redirect_uri",
        "response_type",
        "code_challenge",
        "code_challenge_method",
        "scope",
        "state",
        "resource",
      ]) {
        expect(html).toContain(`name="${field}"`);
      }
      expect(html).toContain(`value="${client.client_id}"`);
      expect(html).toContain(`value="${redirectUri}"`);
      expect(html).toContain('value="code"');
      expect(html).toContain(`value="${params.codeChallenge}"`);
      expect(html).toContain('value="S256"');
      expect(html).toContain('value="health:read activity:read"');
      expect(html).toContain('value="state-value"');
      expect(html).toContain(`value="${resource.href}"`);
      expect(html).toContain("View your daily health summaries");
      expect(html).toContain("Search your activities");
    });

    it("omits the state hidden field when no state parameter is present", async () => {
      const client = makeClient();
      const params = makeParams({ scopes: ["health:read"] });
      const { response, mocks: responseMocks } = makeResponse({ mcpOAuthUserId: "user-1" });

      await provider().authorize(client, params, response);

      const html = responseMocks.send.mock.calls[0]?.[0] ?? "";
      expect(html).not.toContain('name="state"');
    });

    it("defaults scopes and client name on the consent screen", async () => {
      const client = makeClient({ client_name: undefined });
      const params = makeParams({ scopes: undefined });
      const { response, mocks: responseMocks } = makeResponse({ mcpOAuthUserId: "user-1" });

      await provider().authorize(client, params, response);

      const html = responseMocks.send.mock.calls[0]?.[0] ?? "";
      expect(html).toContain("Allow the MCP client to access Dofek?");
      expect(html).toContain("View your daily health summaries");
      expect(html).toContain("Search your activities");
      expect(html).toContain("Log food entries");
      expect(html).toContain("View your connected data sources");
      expect(html).toContain("Start data synchronization");
      expect(html).toContain(`value="${MCP_OAUTH_SCOPES.join(" ")}"`);
    });

    it("treats an empty scopes array as requesting the default scopes", async () => {
      const client = makeClient();
      const params = makeParams({ scopes: [] });
      const { response, mocks: responseMocks } = makeResponse({ mcpOAuthUserId: "user-1" });

      await provider().authorize(client, params, response);

      const html = responseMocks.send.mock.calls[0]?.[0] ?? "";
      expect(html).toContain(`value="${MCP_OAUTH_SCOPES.join(" ")}"`);
      expect(html).toContain("Start data synchronization");
    });

    it("HTML-escapes the client name on the consent screen", async () => {
      const client = makeClient({ client_name: `Claude <script>alert("xss")</script> & 'co'` });
      const params = makeParams({ scopes: ["health:read"] });
      const { response, mocks: responseMocks } = makeResponse({ mcpOAuthUserId: "user-1" });

      await provider().authorize(client, params, response);

      const html = responseMocks.send.mock.calls[0]?.[0] ?? "";
      expect(html).not.toContain("<script>");
      expect(html).toContain(
        "Claude &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &#039;co&#039;",
      );
    });

    it("redirects with access_denied and state when the user denies consent", async () => {
      const client = makeClient();
      const params = makeParams({ state: "state-value" });
      const { response, mocks: responseMocks } = makeResponse({
        mcpOAuthApproval: "deny",
        mcpOAuthUserId: "user-1",
      });

      await provider().authorize(client, params, response);

      const target = responseMocks.redirect.mock.calls[0]?.[0] ?? "";
      expect(target).toContain(redirectUri);
      expect(target).toContain("error=access_denied");
      expect(target).toContain("state=state-value");
    });

    it("redirects with access_denied and no state when consent is denied without state", async () => {
      const client = makeClient();
      const params = makeParams();
      const { response, mocks: responseMocks } = makeResponse({
        mcpOAuthApproval: "deny",
        mcpOAuthUserId: "user-1",
      });

      await provider().authorize(client, params, response);

      const target = responseMocks.redirect.mock.calls[0]?.[0] ?? "";
      expect(target).toContain("error=access_denied");
      expect(target).not.toContain("state=");
    });

    it("issues an authorization code and redirects with code and state on approval", async () => {
      const client = makeClient();
      const params = makeParams({ state: "state-value" });
      const { response, mocks: responseMocks } = makeResponse({
        mcpOAuthApproval: "approve",
        mcpOAuthUserId: "user-1",
      });
      mocks.createAuthorizationCode.mockResolvedValue("dofek_mcp_code_xyz");

      await provider().authorize(client, params, response);

      expect(mocks.createAuthorizationCode).toHaveBeenCalledWith(expect.anything(), {
        clientId: client.client_id,
        codeChallenge: params.codeChallenge,
        redirectUri,
        resource: resource.href,
        scopes: expect.any(Array),
        userId: "user-1",
      });
      const target = responseMocks.redirect.mock.calls[0]?.[0] ?? "";
      expect(target).toContain(`${redirectUri}?code=dofek_mcp_code_xyz`);
      expect(target).toContain("state=state-value");
    });

    it("omits state from the approval redirect when no state was provided", async () => {
      const client = makeClient();
      const params = makeParams();
      const { response, mocks: responseMocks } = makeResponse({
        mcpOAuthApproval: "approve",
        mcpOAuthUserId: "user-1",
      });
      mocks.createAuthorizationCode.mockResolvedValue("dofek_mcp_code_no_state");

      await provider().authorize(client, params, response);

      const target = responseMocks.redirect.mock.calls[0]?.[0] ?? "";
      expect(target).toContain("code=dofek_mcp_code_no_state");
      expect(target).not.toContain("state=");
    });
  });

  describe("challengeForAuthorizationCode", () => {
    it("throws InvalidGrantError when no challenge is stored for the code", async () => {
      mocks.getAuthorizationCodeChallenge.mockResolvedValue(null);
      await expect(
        provider().challengeForAuthorizationCode(makeClient(), "missing-code"),
      ).rejects.toThrow(InvalidGrantError);
    });

    it("returns the stored challenge when one exists", async () => {
      mocks.getAuthorizationCodeChallenge.mockResolvedValue("stored-challenge");
      await expect(
        provider().challengeForAuthorizationCode(makeClient(), "valid-code"),
      ).resolves.toBe("stored-challenge");
    });
  });

  describe("exchangeAuthorizationCode", () => {
    it("throws InvalidGrantError when redirect URI is unset and the client has none registered", async () => {
      const client = makeClient({ redirect_uris: [] });
      await expect(
        provider().exchangeAuthorizationCode(client, "code", "verifier", undefined, resource),
      ).rejects.toThrow("Authorization code parameters do not match");
    });

    it("throws InvalidGrantError when the resource does not match", async () => {
      const client = makeClient();
      await expect(
        provider().exchangeAuthorizationCode(
          client,
          "code",
          "verifier",
          redirectUri,
          new URL("https://other.example/api/mcp"),
        ),
      ).rejects.toThrow("Authorization code parameters do not match");
      expect(mocks.exchangeAuthorizationCode).not.toHaveBeenCalled();
    });

    it("throws InvalidGrantError when the resource parameter is missing", async () => {
      const client = makeClient();
      await expect(
        provider().exchangeAuthorizationCode(client, "code", "verifier", redirectUri, undefined),
      ).rejects.toThrow("Authorization code parameters do not match");
      expect(mocks.exchangeAuthorizationCode).not.toHaveBeenCalled();
    });

    it("exchanges a code when the PKCE verifier matches the stored challenge", async () => {
      const verifier = randomBytes(32).toString("base64url");
      const client = makeClient();
      const exchangeRedirectUri = "https://claude.ai/api/mcp/auth_callback/alt";
      mocks.getAuthorizationCodeChallenge.mockResolvedValue(s256(verifier));
      mocks.exchangeAuthorizationCode.mockResolvedValue({
        accessToken: "at",
        accessTokenExpiresInSeconds: 3600,
        refreshToken: "rt",
        scopes: ["health:read", "activity:read"],
      });

      const tokens = await provider().exchangeAuthorizationCode(
        client,
        "code",
        verifier,
        exchangeRedirectUri,
        resource,
      );

      expect(mocks.exchangeAuthorizationCode).toHaveBeenCalledWith(expect.anything(), {
        clientId: client.client_id,
        code: "code",
        name: "Claude OAuth",
        redirectUri: exchangeRedirectUri,
        resource: resource.href,
      });
      expect(tokens).toEqual({
        access_token: "at",
        expires_in: 3600,
        refresh_token: "rt",
        scope: "health:read activity:read",
        token_type: "bearer",
      });
    });

    it("rejects a mismatched PKCE code_verifier", async () => {
      mocks.getAuthorizationCodeChallenge.mockResolvedValue("different-challenge");
      await expect(
        provider().exchangeAuthorizationCode(
          makeClient(),
          "code",
          "wrong-verifier",
          redirectUri,
          resource,
        ),
      ).rejects.toThrow("PKCE code_verifier does not match challenge");
      expect(mocks.exchangeAuthorizationCode).not.toHaveBeenCalled();
    });

    it("rejects PKCE verification when the stored challenge is missing", async () => {
      mocks.getAuthorizationCodeChallenge.mockResolvedValue(null);
      await expect(
        provider().exchangeAuthorizationCode(
          makeClient(),
          "code",
          "any-verifier",
          redirectUri,
          resource,
        ),
      ).rejects.toThrow("Invalid or expired authorization code");
      expect(mocks.exchangeAuthorizationCode).not.toHaveBeenCalled();
    });

    it("exchanges a code without PKCE validation when no verifier is supplied", async () => {
      const client = makeClient();
      mocks.exchangeAuthorizationCode.mockResolvedValue({
        accessToken: "at",
        accessTokenExpiresInSeconds: 3600,
        refreshToken: "rt",
        scopes: ["health:read"],
      });

      const tokens = await provider().exchangeAuthorizationCode(
        client,
        "code",
        undefined,
        redirectUri,
        resource,
      );

      expect(mocks.getAuthorizationCodeChallenge).not.toHaveBeenCalled();
      expect(mocks.exchangeAuthorizationCode).toHaveBeenCalledWith(expect.anything(), {
        clientId: client.client_id,
        code: "code",
        name: "Claude OAuth",
        redirectUri,
        resource: resource.href,
      });
      expect(tokens.access_token).toBe("at");
    });

    it("throws InvalidGrantError when the code cannot be exchanged", async () => {
      mocks.exchangeAuthorizationCode.mockResolvedValue(null);
      await expect(
        provider().exchangeAuthorizationCode(
          makeClient(),
          "code",
          undefined,
          redirectUri,
          resource,
        ),
      ).rejects.toThrow("Invalid or expired authorization code");
    });
  });

  describe("exchangeRefreshToken", () => {
    it("throws InvalidGrantError when the resource parameter is missing", async () => {
      await expect(
        provider().exchangeRefreshToken(makeClient(), "refresh-token", ["health:read"], undefined),
      ).rejects.toThrow("Refresh token resource does not match");
      expect(mocks.rotateRefreshToken).not.toHaveBeenCalled();
    });

    it("throws InvalidGrantError when the resource does not match", async () => {
      await expect(
        provider().exchangeRefreshToken(
          makeClient(),
          "refresh-token",
          ["health:read"],
          new URL("https://other.example/api/mcp"),
        ),
      ).rejects.toThrow("Refresh token resource does not match");
      expect(mocks.rotateRefreshToken).not.toHaveBeenCalled();
    });

    it("rotates the refresh token and returns new tokens for matching scopes", async () => {
      const client = makeClient();
      mocks.rotateRefreshToken.mockResolvedValue({
        accessToken: "at-2",
        accessTokenExpiresInSeconds: 3600,
        refreshToken: "rt-2",
        scopes: ["health:read", "activity:read"],
      });

      const tokens = await provider().exchangeRefreshToken(
        client,
        "refresh-token",
        ["health:read"],
        resource,
      );

      expect(mocks.rotateRefreshToken).toHaveBeenCalledWith(expect.anything(), {
        clientId: client.client_id,
        name: "Claude OAuth",
        refreshToken: "refresh-token",
        requestedScopes: ["health:read"],
        resource: resource.href,
      });
      expect(tokens).toEqual({
        access_token: "at-2",
        expires_in: 3600,
        refresh_token: "rt-2",
        scope: "health:read activity:read",
        token_type: "bearer",
      });
    });

    it("throws InvalidScopeError when requesting unsupported scopes", async () => {
      await expect(
        provider().exchangeRefreshToken(makeClient(), "refresh-token", ["invalid:scope"], resource),
      ).rejects.toThrow(InvalidScopeError);
    });

    it("throws InvalidGrantError when the refresh token cannot be rotated", async () => {
      mocks.rotateRefreshToken.mockResolvedValue(null);
      await expect(
        provider().exchangeRefreshToken(makeClient(), "refresh-token", undefined, resource),
      ).rejects.toThrow("Invalid, expired, or reused refresh token");
    });
  });

  describe("verifyAccessToken", () => {
    it("throws InvalidTokenError when the token is invalid", async () => {
      mocks.validateMcpToken.mockResolvedValue(null);
      await expect(provider().verifyAccessToken("bad-token")).rejects.toThrow(InvalidTokenError);
    });

    it("throws InvalidTokenError when the token has no OAuth client", async () => {
      mocks.validateMcpToken.mockResolvedValue({
        expiresAt: null,
        oauthClientId: null,
        oauthResource: resource.href,
        scopes: ["health:read"],
        tokenId: "token-id",
        userId: "user-1",
      });
      await expect(provider().verifyAccessToken("token")).rejects.toThrow(InvalidTokenError);
    });

    it("throws InvalidTokenError when the token resource does not match", async () => {
      mocks.validateMcpToken.mockResolvedValue({
        expiresAt: null,
        oauthClientId: "client-1",
        oauthResource: "https://other.example/api/mcp",
        scopes: ["health:read"],
        tokenId: "token-id",
        userId: "user-1",
      });
      await expect(provider().verifyAccessToken("token")).rejects.toThrow(InvalidTokenError);
    });

    it("returns AuthInfo with the user id and an epoch expiresAt for a valid token", async () => {
      mocks.validateMcpToken.mockResolvedValue({
        expiresAt: "2026-01-15T00:00:00.000Z",
        oauthClientId: "client-1",
        oauthResource: resource.href,
        scopes: ["health:read", "activity:read"],
        tokenId: "token-id",
        userId: "user-7",
      });

      const authInfo = await provider().verifyAccessToken("token");

      expect(authInfo.clientId).toBe("client-1");
      expect(authInfo.extra).toEqual({ userId: "user-7" });
      expect(authInfo.expiresAt).toBe(
        Math.floor(new Date("2026-01-15T00:00:00.000Z").getTime() / 1000),
      );
      expect(authInfo.resource).toEqual(resource);
      expect(authInfo.scopes).toEqual(["health:read", "activity:read"]);
      expect(authInfo.token).toBe("token");
    });

    it("returns AuthInfo with undefined expiresAt when the token never expires", async () => {
      mocks.validateMcpToken.mockResolvedValue({
        expiresAt: null,
        oauthClientId: "client-1",
        oauthResource: resource.href,
        scopes: ["health:read"],
        tokenId: "token-id",
        userId: "user-7",
      });

      const authInfo = await provider().verifyAccessToken("token");
      expect(authInfo.expiresAt).toBeUndefined();
    });
  });

  describe("revokeToken", () => {
    it("delegates revocation to the repository with the client id and token", async () => {
      const client = makeClient({ client_id: "client-revoke" });
      const request: OAuthTokenRevocationRequest = { token: "token-to-revoke" };

      await provider().revokeToken(client, request);

      expect(mocks.revokeOAuthToken).toHaveBeenCalledWith(
        expect.anything(),
        "client-revoke",
        "token-to-revoke",
      );
    });
  });
});
