import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock arctic before importing
vi.mock("arctic", () => {
  const mockTokens = { idToken: () => "mock-id-token" };
  return {
    Google: vi.fn().mockImplementation(() => ({
      createAuthorizationURL: vi.fn().mockReturnValue(new URL("https://accounts.google.com/auth")),
      validateAuthorizationCode: vi.fn().mockResolvedValue(mockTokens),
    })),
    Apple: vi.fn().mockImplementation(() => ({
      createAuthorizationURL: vi.fn().mockReturnValue(new URL("https://appleid.apple.com/auth")),
      validateAuthorizationCode: vi.fn().mockResolvedValue(mockTokens),
    })),
    Authentik: vi.fn().mockImplementation(() => ({
      createAuthorizationURL: vi
        .fn()
        .mockReturnValue(new URL("https://auth.example.com/authorize")),
      validateAuthorizationCode: vi.fn().mockResolvedValue(mockTokens),
    })),
    decodeIdToken: vi.fn().mockReturnValue({
      sub: "user-123",
      email: "test@example.com",
      name: "Test User",
    }),
    generateCodeVerifier: vi.fn().mockReturnValue("test-verifier"),
    generateState: vi.fn().mockReturnValue("test-state"),
  };
});

import {
  decodePemToDer,
  getConfiguredProviders,
  getIdentityProvider,
  isProviderConfigured,
} from "./providers.ts";

describe("auth/providers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    // Save and clear env
    process.env = { ...originalEnv };
    // Clear all provider env vars
    for (const key of [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REDIRECT_URI",
      "APPLE_CLIENT_ID",
      "APPLE_TEAM_ID",
      "APPLE_KEY_ID",
      "APPLE_PRIVATE_KEY",
      "APPLE_REDIRECT_URI",
      "AUTHENTIK_BASE_URL",
      "AUTHENTIK_CLIENT_ID",
      "AUTHENTIK_CLIENT_SECRET",
      "AUTHENTIK_REDIRECT_URI",
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("isProviderConfigured", () => {
    it("returns false when no Google env vars are set", () => {
      expect(isProviderConfigured("google")).toBe(false);
    });

    it("returns false when only some Google env vars are set", () => {
      process.env.GOOGLE_CLIENT_ID = "id";
      expect(isProviderConfigured("google")).toBe(false);
    });

    it("returns true when all Google env vars are set", () => {
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REDIRECT_URI = "http://localhost/callback";
      expect(isProviderConfigured("google")).toBe(true);
    });

    it("returns false when no Apple env vars are set", () => {
      expect(isProviderConfigured("apple")).toBe(false);
    });

    it("returns true when all Apple env vars are set", () => {
      process.env.APPLE_CLIENT_ID = "id";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY =
        "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";
      process.env.APPLE_REDIRECT_URI = "http://localhost/callback";
      expect(isProviderConfigured("apple")).toBe(true);
    });

    it("returns false when no Authentik env vars are set", () => {
      expect(isProviderConfigured("authentik")).toBe(false);
    });

    it("returns true when all Authentik env vars are set", () => {
      process.env.AUTHENTIK_BASE_URL = "https://auth.example.com";
      process.env.AUTHENTIK_CLIENT_ID = "id";
      process.env.AUTHENTIK_CLIENT_SECRET = "secret";
      process.env.AUTHENTIK_REDIRECT_URI = "http://localhost/callback";
      expect(isProviderConfigured("authentik")).toBe(true);
    });
  });

  describe("getConfiguredProviders", () => {
    it("returns empty array when no providers are configured", () => {
      expect(getConfiguredProviders()).toEqual([]);
    });

    it("returns only configured providers", () => {
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REDIRECT_URI = "http://localhost/callback";

      const result = getConfiguredProviders();
      expect(result).toContain("google");
      expect(result).not.toContain("apple");
      expect(result).not.toContain("authentik");
    });

    it("returns multiple configured providers", () => {
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REDIRECT_URI = "http://localhost/callback";
      process.env.AUTHENTIK_BASE_URL = "https://auth.example.com";
      process.env.AUTHENTIK_CLIENT_ID = "id";
      process.env.AUTHENTIK_CLIENT_SECRET = "secret";
      process.env.AUTHENTIK_REDIRECT_URI = "http://localhost/callback";

      const result = getConfiguredProviders();
      expect(result).toContain("google");
      expect(result).toContain("authentik");
      expect(result).not.toContain("apple");
    });
  });

  describe("getIdentityProvider", () => {
    it("throws when required env vars are missing for Google", () => {
      expect(() => getIdentityProvider("google")).toThrow("Missing required env var");
    });

    it("creates and caches Google provider", () => {
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("google");
      expect(provider).toBeDefined();
      expect(provider.createAuthorizationUrl).toBeTypeOf("function");
      expect(provider.validateCallback).toBeTypeOf("function");

      // Second call should return same instance (cached)
      const provider2 = getIdentityProvider("google");
      expect(provider2).toBe(provider);
    });

    it("creates Google authorization URL", () => {
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("google");
      const url = provider.createAuthorizationUrl("state-123", "verifier-456");
      expect(url).toBeInstanceOf(URL);
    });

    it("creates Apple provider with DER-decoded private key", async () => {
      process.env.APPLE_CLIENT_ID = "id";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY =
        "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----";
      process.env.APPLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("apple");
      expect(provider).toBeDefined();

      // Verify Apple constructor received DER bytes, not raw PEM text
      const { Apple: AppleMock } = await import("arctic");
      const appleMock: ReturnType<typeof vi.fn> = vi.mocked(AppleMock);
      const constructorCall = appleMock.mock.calls[0];
      const keyArg = constructorCall[3];
      // Should be the base64-decoded DER bytes [1, 2, 3], not the UTF-8 encoded PEM string
      expect(keyArg).toBeInstanceOf(Uint8Array);
      expect(Array.from(keyArg)).toEqual([1, 2, 3]);
    });

    it("creates Authentik provider when env vars are set", () => {
      process.env.AUTHENTIK_BASE_URL = "https://auth.example.com";
      process.env.AUTHENTIK_CLIENT_ID = "id";
      process.env.AUTHENTIK_CLIENT_SECRET = "secret";
      process.env.AUTHENTIK_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("authentik");
      expect(provider).toBeDefined();
    });

    it("creates Apple authorization URL (no PKCE)", () => {
      process.env.APPLE_CLIENT_ID = "id";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY =
        "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";
      process.env.APPLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("apple");
      const url = provider.createAuthorizationUrl("state-abc", "verifier-unused");
      expect(url).toBeInstanceOf(URL);
    });

    it("creates Authentik authorization URL with PKCE", () => {
      process.env.AUTHENTIK_BASE_URL = "https://auth.example.com";
      process.env.AUTHENTIK_CLIENT_ID = "id";
      process.env.AUTHENTIK_CLIENT_SECRET = "secret";
      process.env.AUTHENTIK_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("authentik");
      const url = provider.createAuthorizationUrl("state-xyz", "verifier-xyz");
      expect(url).toBeInstanceOf(URL);
    });

    it("validates Google callback and returns user info", async () => {
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("google");
      const result = await provider.validateCallback("auth-code", "verifier");

      // The mock decodeIdToken returns sub/email/name
      expect(result.user.sub).toBe("user-123");
      expect(result.user.email).toBe("test@example.com");
      expect(result.user.name).toBe("Test User");
    });

    it("validates Apple callback (no PKCE verifier)", async () => {
      process.env.APPLE_CLIENT_ID = "id";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY =
        "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";
      process.env.APPLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("apple");
      const result = await provider.validateCallback("apple-code", "unused-verifier");

      // Apple returns name as null (only sent on first auth, not in ID token)
      expect(result.user.sub).toBe("user-123");
      expect(result.user.name).toBeNull();
    });

    it("validates Authentik callback and returns user info", async () => {
      process.env.AUTHENTIK_BASE_URL = "https://auth.example.com";
      process.env.AUTHENTIK_CLIENT_ID = "id";
      process.env.AUTHENTIK_CLIENT_SECRET = "secret";
      process.env.AUTHENTIK_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("authentik");
      const result = await provider.validateCallback("authentik-code", "authentik-verifier");

      // The mock decodeIdToken returns name directly
      expect(result.user.sub).toBe("user-123");
      expect(result.user.email).toBe("test@example.com");
      expect(result.user.name).toBe("Test User");
    });
  });

  describe("decodePemToDer", () => {
    it("strips PEM headers and decodes base64 to raw bytes", () => {
      // 4 bytes of data (AQID) = [1, 2, 3]
      const pem = "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----";
      const result = decodePemToDer(pem);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual([1, 2, 3]);
    });

    it("handles PEM without newlines", () => {
      const pem = "-----BEGIN PRIVATE KEY-----AQID-----END PRIVATE KEY-----";
      const result = decodePemToDer(pem);
      expect(Array.from(result)).toEqual([1, 2, 3]);
    });

    it("handles multi-line base64 content", () => {
      const pem = "-----BEGIN PRIVATE KEY-----\nAQID\nBAUG\n-----END PRIVATE KEY-----";
      const result = decodePemToDer(pem);
      expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  describe("generateCodeVerifier and generateState", () => {
    it("re-exports generateCodeVerifier from arctic", async () => {
      const { generateCodeVerifier: gcv } = await import("./providers.ts");
      expect(gcv).toBeTypeOf("function");
      expect(gcv()).toBe("test-verifier");
    });

    it("re-exports generateState from arctic", async () => {
      const { generateState: gs } = await import("./providers.ts");
      expect(gs).toBeTypeOf("function");
      expect(gs()).toBe("test-state");
    });
  });
});
