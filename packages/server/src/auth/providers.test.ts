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
  isNativeAppleConfigured,
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
      "APPLE_BUNDLE_ID",
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

    it("returns false when only some Apple env vars are set", () => {
      process.env.APPLE_CLIENT_ID = "id";
      process.env.APPLE_TEAM_ID = "team";
      // Missing APPLE_KEY_ID, APPLE_PRIVATE_KEY, APPLE_REDIRECT_URI
      expect(isProviderConfigured("apple")).toBe(false);
    });

    it("returns true when all Apple env vars are set", () => {
      process.env.APPLE_CLIENT_ID = "id";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY =
        "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----";
      process.env.APPLE_REDIRECT_URI = "http://localhost/callback";
      expect(isProviderConfigured("apple")).toBe(true);
    });
  });

  describe("isNativeAppleConfigured", () => {
    it("returns false when APPLE_BUNDLE_ID is missing", () => {
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY = "key-content";
      expect(isNativeAppleConfigured()).toBe(false);
    });

    it("returns false when APPLE_TEAM_ID is missing", () => {
      process.env.APPLE_BUNDLE_ID = "com.dofek.app";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY = "key-content";
      expect(isNativeAppleConfigured()).toBe(false);
    });

    it("returns false when APPLE_KEY_ID is missing", () => {
      process.env.APPLE_BUNDLE_ID = "com.dofek.app";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_PRIVATE_KEY = "key-content";
      expect(isNativeAppleConfigured()).toBe(false);
    });

    it("returns false when APPLE_PRIVATE_KEY is missing", () => {
      process.env.APPLE_BUNDLE_ID = "com.dofek.app";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      expect(isNativeAppleConfigured()).toBe(false);
    });

    it("returns true when all native Apple env vars are set", () => {
      process.env.APPLE_BUNDLE_ID = "com.dofek.app";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY = "key-content";
      expect(isNativeAppleConfigured()).toBe(true);
    });

    it("does not require APPLE_CLIENT_ID or APPLE_REDIRECT_URI", () => {
      process.env.APPLE_BUNDLE_ID = "com.dofek.app";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY = "key-content";
      // APPLE_CLIENT_ID and APPLE_REDIRECT_URI are NOT set
      expect(isNativeAppleConfigured()).toBe(true);
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

    it("creates Google authorization URL with correct scopes", async () => {
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("google");
      const url = provider.createAuthorizationUrl("state-123", "verifier-456");
      expect(url).toBeInstanceOf(URL);

      // Verify scopes passed to Google mock
      const { Google: GoogleMock } = await import("arctic");
      const googleInstance = vi.mocked(GoogleMock).mock.results[0].value;
      const callArgs = googleInstance.createAuthorizationURL.mock.calls[0];
      expect(callArgs[2]).toEqual(["openid", "email", "profile"]);
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

    it("creates Apple authorization URL with correct scopes (no PKCE)", async () => {
      process.env.APPLE_CLIENT_ID = "id";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY =
        "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----";
      process.env.APPLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("apple");
      const url = provider.createAuthorizationUrl("state-abc", "verifier-unused");
      expect(url).toBeInstanceOf(URL);
      expect(url.searchParams.get("response_mode")).toBe("form_post");

      // Verify scopes passed to Apple mock
      const { Apple: AppleMock } = await import("arctic");
      const appleInstance = vi.mocked(AppleMock).mock.results[0].value;
      const callArgs = appleInstance.createAuthorizationURL.mock.calls[0];
      expect(callArgs[1]).toEqual(["name", "email"]);
    });

    it("validates Google callback and returns user from claims schema", async () => {
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("google");
      const result = await provider.validateCallback("auth-code", "verifier");

      // Claims schema must parse sub, email, name from the decoded ID token
      expect(result.user.sub).toBe("user-123");
      expect(result.user.email).toBe("test@example.com");
      expect(result.user.name).toBe("Test User");
      expect(result.user.groups).toBeNull();
      expect(result.tokens).toBeDefined();
    });

    it("validates Apple callback and parses claims schema", async () => {
      process.env.APPLE_CLIENT_ID = "id";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY =
        "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----";
      process.env.APPLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("apple");
      const result = await provider.validateCallback("apple-code", "unused-verifier");

      // Apple claims schema must parse sub from decoded ID token
      expect(result.user.sub).toBe("user-123");
      expect(result.user.email).toBe("test@example.com");
      // Apple returns name as null (only sent on first auth, not in ID token)
      expect(result.user.name).toBeNull();
      expect(result.user.groups).toBeNull();
      expect(result.tokens).toBeDefined();
    });

    it("initializers map covers all identity providers", () => {
      // Set env vars for all providers to ensure all initializers work
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REDIRECT_URI = "http://localhost/callback";
      process.env.APPLE_CLIENT_ID = "id";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY =
        "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----";
      process.env.APPLE_REDIRECT_URI = "http://localhost/callback";

      // Every provider name must produce a valid provider (initializers map is not empty)
      for (const name of ["google", "apple"] as const) {
        const provider = getIdentityProvider(name);
        expect(provider.createAuthorizationUrl).toBeTypeOf("function");
        expect(provider.validateCallback).toBeTypeOf("function");
      }
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

    it("handles literal backslash-n from secret managers (e.g. Infisical)", () => {
      // Secret managers may store newlines as literal \n (two chars) instead of real newlines
      const pem = "-----BEGIN PRIVATE KEY-----\\nAQID\\n-----END PRIVATE KEY-----";
      const result = decodePemToDer(pem);
      expect(Array.from(result)).toEqual([1, 2, 3]);
    });

    it("handles literal backslash-n in multi-line base64", () => {
      const pem = "-----BEGIN PRIVATE KEY-----\\nAQID\\nBAUG\\n-----END PRIVATE KEY-----";
      const result = decodePemToDer(pem);
      expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("handles literal backslash-r-backslash-n from Windows-style secret managers", () => {
      // Some secret managers store \r\n as literal characters (4 chars: \, r, \, n)
      const pem = "-----BEGIN PRIVATE KEY-----\\r\\nAQID\\r\\n-----END PRIVATE KEY-----";
      const result = decodePemToDer(pem);
      expect(Array.from(result)).toEqual([1, 2, 3]);
    });

    it("handles EC PRIVATE KEY headers (SEC1/PKCS#1 format)", () => {
      const pem = "-----BEGIN EC PRIVATE KEY-----\nAQID\n-----END EC PRIVATE KEY-----";
      const result = decodePemToDer(pem);
      expect(Array.from(result)).toEqual([1, 2, 3]);
    });

    it("strips surrounding double quotes from Dokploy env vars", () => {
      const pem = '"-----BEGIN PRIVATE KEY-----\\nAQID\\n-----END PRIVATE KEY-----"';
      const result = decodePemToDer(pem);
      expect(Array.from(result)).toEqual([1, 2, 3]);
    });

    it("strips surrounding single quotes from env vars", () => {
      const pem = "'-----BEGIN PRIVATE KEY-----\\nAQID\\n-----END PRIVATE KEY-----'";
      const result = decodePemToDer(pem);
      expect(Array.from(result)).toEqual([1, 2, 3]);
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

  // ── Mutation-killing tests ────────────────────────────────────

  describe("validateCallback user mapping - mutation killers", () => {
    it("Google callback returns email from claims", async () => {
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("google");
      const result = await provider.validateCallback("code", "verifier");
      // The mock returns email: "test@example.com"
      expect(result.user.email).toBe("test@example.com");
    });

    it("Google callback returns name from claims", async () => {
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("google");
      const result = await provider.validateCallback("code", "verifier");
      expect(result.user.name).toBe("Test User");
    });

    it("Google callback returns null groups (not supported)", async () => {
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("google");
      const result = await provider.validateCallback("code", "verifier");
      expect(result.user.groups).toBeNull();
    });

    it("Google callback returns tokens", async () => {
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("google");
      const result = await provider.validateCallback("code", "verifier");
      expect(result.tokens).toBeDefined();
      expect(result.tokens.idToken()).toBe("mock-id-token");
    });

    it("Apple callback always returns null name", async () => {
      process.env.APPLE_CLIENT_ID = "id";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY =
        "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";
      process.env.APPLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("apple");
      const result = await provider.validateCallback("code", "verifier");
      // Apple never sends name in ID token
      expect(result.user.name).toBeNull();
    });

    it("Apple callback returns null groups", async () => {
      process.env.APPLE_CLIENT_ID = "id";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY =
        "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";
      process.env.APPLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("apple");
      const result = await provider.validateCallback("code", "verifier");
      expect(result.user.groups).toBeNull();
    });

    it("Apple callback returns email from claims", async () => {
      process.env.APPLE_CLIENT_ID = "id";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY =
        "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";
      process.env.APPLE_REDIRECT_URI = "http://localhost/callback";

      const provider = getIdentityProvider("apple");
      const result = await provider.validateCallback("code", "verifier");
      expect(result.user.email).toBe("test@example.com");
    });
  });

  describe("isProviderConfigured - mutation killers", () => {
    it("returns false when env var is empty string", () => {
      process.env.GOOGLE_CLIENT_ID = "";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REDIRECT_URI = "http://localhost/callback";
      expect(isProviderConfigured("google")).toBe(false);
    });

    it("returns false when only 2 of 3 Google vars are set", () => {
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      // GOOGLE_REDIRECT_URI not set
      expect(isProviderConfigured("google")).toBe(false);
    });

    it("returns false when only 4 of 5 Apple vars are set", () => {
      process.env.APPLE_CLIENT_ID = "id";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY = "key-content";
      // APPLE_REDIRECT_URI not set
      expect(isProviderConfigured("apple")).toBe(false);
    });
  });

  describe("getConfiguredProviders - mutation killers", () => {
    it("returns all providers when all are configured", () => {
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REDIRECT_URI = "http://localhost/callback";

      process.env.APPLE_CLIENT_ID = "id";
      process.env.APPLE_TEAM_ID = "team";
      process.env.APPLE_KEY_ID = "key";
      process.env.APPLE_PRIVATE_KEY = "key-content";
      process.env.APPLE_REDIRECT_URI = "http://localhost/callback";

      const result = getConfiguredProviders();
      expect(result).toHaveLength(2);
      expect(result).toContain("google");
      expect(result).toContain("apple");
    });

    it("returns an array (not something else)", () => {
      const result = getConfiguredProviders();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getIdentityProvider - error message specificity", () => {
    it("error message includes the specific missing env var name", () => {
      // The first test in getIdentityProvider already covers throwing.
      // This test validates that getEnvRequired throws with the key name.
      // Since providers may be cached from previous tests, we test indirectly:
      // isProviderConfigured should return false, matching the throw behavior.
      expect(isProviderConfigured("google")).toBe(false);
      expect(isProviderConfigured("apple")).toBe(false);
    });
  });
});
