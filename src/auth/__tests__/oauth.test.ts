import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  type OAuthConfig,
  type TokenSet,
} from "../oauth.js";

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
      const mockResponse: TokenSet = {
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
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.example.com/oauth/token");
      expect(options.method).toBe("POST");

      const body = new URLSearchParams(options.body);
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

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.example.com/oauth/token");

      const body = new URLSearchParams(options.body);
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
});
