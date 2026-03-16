import { describe, expect, it, vi } from "vitest";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  type OAuthConfig,
  refreshAccessToken,
  type TokenSet,
} from "./oauth.ts";

const config: OAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  authorizeUrl: "https://api.example.com/oauth/authorize",
  tokenUrl: "https://api.example.com/oauth/token",
  redirectUri: "http://localhost:9876/callback",
  scopes: ["user_read", "workouts_read"],
};

describe("OAuth", () => {
  describe("buildAuthorizationUrl", () => {
    it("builds a correct authorization URL with all parameters", () => {
      const url = buildAuthorizationUrl(config);
      const parsed = new URL(url);

      expect(parsed.origin + parsed.pathname).toBe("https://api.example.com/oauth/authorize");
      expect(parsed.searchParams.get("client_id")).toBe("test-client-id");
      expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:9876/callback");
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("scope")).toBe("user_read workouts_read");
    });
  });

  describe("exchangeCodeForTokens", () => {
    it("exchanges an authorization code for tokens", async () => {
      const _mockResponse: TokenSet = {
        accessToken: "access-123",
        refreshToken: "refresh-456",
        expiresAt: new Date("2025-01-01T02:00:00Z"),
        scopes: "user_read workouts_read",
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "access-123",
            refresh_token: "refresh-456",
            expires_in: 7200,
            scope: "user_read workouts_read",
          }),
      });

      const result = await exchangeCodeForTokens(config, "auth-code-789", mockFetch);

      expect(mockFetch).toHaveBeenCalledOnce();
      const call = mockFetch.mock.calls[0];
      const [url, options] = call ?? [];
      expect(url).toBe("https://api.example.com/oauth/token");
      expect(options?.method).toBe("POST");

      const body = new URLSearchParams(options?.body);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("auth-code-789");
      expect(body.get("client_id")).toBe("test-client-id");
      expect(body.get("client_secret")).toBe("test-client-secret");
      expect(body.get("redirect_uri")).toBe("http://localhost:9876/callback");

      expect(result.accessToken).toBe("access-123");
      expect(result.refreshToken).toBe("refresh-456");
      expect(result.scopes).toBe("user_read workouts_read");
    });

    it("throws on failed token exchange", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Invalid code"),
      });

      await expect(exchangeCodeForTokens(config, "bad-code", mockFetch)).rejects.toThrow(
        "Token exchange failed (401)",
      );
    });
  });

  describe("refreshAccessToken", () => {
    it("refreshes an expired access token", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-access-123",
            refresh_token: "new-refresh-456",
            expires_in: 7200,
            scope: "user_read workouts_read",
          }),
      });

      const result = await refreshAccessToken(config, "old-refresh-token", mockFetch);

      const refreshCall = mockFetch.mock.calls[0];
      const [url, options] = refreshCall ?? [];
      expect(url).toBe("https://api.example.com/oauth/token");

      const body = new URLSearchParams(options?.body);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old-refresh-token");

      expect(result.accessToken).toBe("new-access-123");
      expect(result.refreshToken).toBe("new-refresh-456");
    });

    it("throws on failed refresh", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Token revoked"),
      });

      await expect(refreshAccessToken(config, "revoked-token", mockFetch)).rejects.toThrow(
        "Token refresh failed (401)",
      );
    });
  });

  describe("PKCE", () => {
    it("generates a code verifier of correct length", () => {
      const verifier = generateCodeVerifier();
      // 32 bytes base64url = 43 chars
      expect(verifier.length).toBe(43);
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("generates unique verifiers", () => {
      const v1 = generateCodeVerifier();
      const v2 = generateCodeVerifier();
      expect(v1).not.toBe(v2);
    });

    it("generates a valid S256 code challenge from verifier", () => {
      const verifier = generateCodeVerifier();
      const challenge = generateCodeChallenge(verifier);
      // SHA-256 base64url = 43 chars
      expect(challenge.length).toBe(43);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("same verifier always produces same challenge", () => {
      const verifier = "test-verifier-value-1234567890abcdefghijk";
      const c1 = generateCodeChallenge(verifier);
      const c2 = generateCodeChallenge(verifier);
      expect(c1).toBe(c2);
    });

    it("includes PKCE params in authorization URL", () => {
      const url = buildAuthorizationUrl(config, { codeChallenge: "test-challenge-abc" });
      const parsed = new URL(url);

      expect(parsed.searchParams.get("code_challenge")).toBe("test-challenge-abc");
      expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("includes audience in authorization URL when configured", () => {
      const pkceConfig: OAuthConfig = {
        ...config,
        audience: "https://api.example.com/",
        usePkce: true,
      };
      const url = buildAuthorizationUrl(pkceConfig);
      const parsed = new URL(url);

      expect(parsed.searchParams.get("audience")).toBe("https://api.example.com/");
    });

    it("uses custom scope separator", () => {
      const stravaConfig: OAuthConfig = {
        ...config,
        scopeSeparator: ",",
      };
      const url = buildAuthorizationUrl(stravaConfig);
      const parsed = new URL(url);
      expect(parsed.searchParams.get("scope")).toBe("user_read,workouts_read");
    });

    it("uses Basic auth when tokenAuthMethod is basic", async () => {
      const basicConfig: OAuthConfig = {
        ...config,
        tokenAuthMethod: "basic",
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "basic-access",
            refresh_token: "basic-refresh",
          }),
      });

      await exchangeCodeForTokens(basicConfig, "code", mockFetch);

      const [, options] = mockFetch.mock.calls[0] ?? [];
      // Should have Authorization header
      expect(options?.headers?.Authorization).toMatch(/^Basic /);
      // Should NOT have client_id/client_secret in body
      const body = new URLSearchParams(options?.body);
      expect(body.get("client_id")).toBeNull();
      expect(body.get("client_secret")).toBeNull();
    });

    it("uses Basic auth for refresh when tokenAuthMethod is basic", async () => {
      const basicConfig: OAuthConfig = {
        ...config,
        tokenAuthMethod: "basic",
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "basic-access",
            refresh_token: "basic-refresh",
          }),
      });

      await refreshAccessToken(basicConfig, "refresh-tok", mockFetch);

      const [, options] = mockFetch.mock.calls[0] ?? [];
      expect(options?.headers?.Authorization).toMatch(/^Basic /);
    });

    it("defaults expires_in to 7200 when not in response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "access",
            refresh_token: "refresh",
            // No expires_in
          }),
      });

      const result = await exchangeCodeForTokens(config, "code", mockFetch);
      // Should default to 7200s (2 hours) from now
      const expectedMin = Date.now() + 7100 * 1000;
      const expectedMax = Date.now() + 7300 * 1000;
      expect(result.expiresAt.getTime()).toBeGreaterThan(expectedMin);
      expect(result.expiresAt.getTime()).toBeLessThan(expectedMax);
      expect(result.scopes).toBeNull(); // No scope in response
    });

    it("does not include audience when not configured", () => {
      const url = buildAuthorizationUrl(config);
      const parsed = new URL(url);
      expect(parsed.searchParams.has("audience")).toBe(false);
    });

    it("does not include code_challenge when no pkce param", () => {
      const url = buildAuthorizationUrl(config);
      const parsed = new URL(url);
      expect(parsed.searchParams.has("code_challenge")).toBe(false);
      expect(parsed.searchParams.has("code_challenge_method")).toBe(false);
    });

    it("uses space as default scope separator", () => {
      const url = buildAuthorizationUrl(config);
      const parsed = new URL(url);
      expect(parsed.searchParams.get("scope")).toBe("user_read workouts_read");
    });

    it("includes client_id in body when not using basic auth", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
      });

      await exchangeCodeForTokens(config, "code", mockFetch);
      const body = new URLSearchParams(mockFetch.mock.calls[0]?.[1]?.body);
      expect(body.get("client_id")).toBe("test-client-id");
      expect(body.get("client_secret")).toBe("test-client-secret");
    });

    it("omits client_secret from body when not provided", async () => {
      const noSecretConfig: OAuthConfig = { ...config, clientSecret: undefined };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: "a", refresh_token: "r" }),
      });

      await exchangeCodeForTokens(noSecretConfig, "code", mockFetch);
      const body = new URLSearchParams(mockFetch.mock.calls[0]?.[1]?.body);
      expect(body.get("client_id")).toBe("test-client-id");
      expect(body.has("client_secret")).toBe(false);
    });

    it("Basic auth header has correct base64 encoding", async () => {
      const basicConfig: OAuthConfig = { ...config, tokenAuthMethod: "basic" };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: "a", refresh_token: "r" }),
      });

      await exchangeCodeForTokens(basicConfig, "code", mockFetch);
      const headers = mockFetch.mock.calls[0]?.[1]?.headers;
      const expected = `Basic ${btoa("test-client-id:test-client-secret")}`;
      expect(headers?.Authorization).toBe(expected);
    });

    it("Basic auth without clientSecret omits Authorization header", async () => {
      const basicNoSecret: OAuthConfig = {
        ...config,
        tokenAuthMethod: "basic",
        clientSecret: undefined,
      };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: "a", refresh_token: "r" }),
      });

      await exchangeCodeForTokens(basicNoSecret, "code", mockFetch);
      const headers = mockFetch.mock.calls[0]?.[1]?.headers;
      expect(headers?.Authorization).toBeUndefined();
    });

    it("refreshAccessToken sends correct grant_type and refresh_token", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
      });

      await refreshAccessToken(config, "my-refresh-tok", mockFetch);
      const body = new URLSearchParams(mockFetch.mock.calls[0]?.[1]?.body);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("my-refresh-tok");
      expect(body.get("client_id")).toBe("test-client-id");
      expect(body.get("client_secret")).toBe("test-client-secret");
    });

    it("refreshAccessToken with basic auth omits client_id from body", async () => {
      const basicConfig: OAuthConfig = { ...config, tokenAuthMethod: "basic" };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: "a", refresh_token: "r" }),
      });

      await refreshAccessToken(basicConfig, "tok", mockFetch);
      const body = new URLSearchParams(mockFetch.mock.calls[0]?.[1]?.body);
      expect(body.has("client_id")).toBe(false);
      expect(body.has("client_secret")).toBe(false);
    });

    it("Content-Type header is always application/x-www-form-urlencoded", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: "a", refresh_token: "r" }),
      });

      await exchangeCodeForTokens(config, "code", mockFetch);
      expect(mockFetch.mock.calls[0]?.[1]?.headers?.["Content-Type"]).toBe(
        "application/x-www-form-urlencoded",
      );
    });

    it("returns null refreshToken when provider omits refresh_token", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "polar-access",
            expires_in: 999999,
            scope: "accesslink.read_all",
          }),
      });

      const result = await exchangeCodeForTokens(config, "code", mockFetch);
      expect(result.accessToken).toBe("polar-access");
      expect(result.refreshToken).toBeNull();
    });

    it("sends code_verifier instead of client_secret in token exchange", async () => {
      const pkceConfig: OAuthConfig = {
        ...config,
        clientSecret: undefined,
        usePkce: true,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "pkce-access",
            refresh_token: "pkce-refresh",
            expires_in: 172800,
            scope: "openid offline_access",
          }),
      });

      await exchangeCodeForTokens(pkceConfig, "auth-code", mockFetch, {
        codeVerifier: "my-verifier",
      });

      const pkceCall = mockFetch.mock.calls[0] ?? [];
      const [, options] = pkceCall;
      const body = new URLSearchParams(options?.body);
      expect(body.get("code_verifier")).toBe("my-verifier");
      expect(body.get("client_secret")).toBeNull();
    });
  });
});
