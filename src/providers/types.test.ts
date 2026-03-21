import { describe, expect, it } from "vitest";
import type { Provider, ProviderAuthSetup } from "./types.ts";
import { getProviderAuthType } from "./types.ts";

function stubProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "test",
    name: "Test",
    validate: () => null,
    sync: async () => ({ provider: "test", recordsSynced: 0, errors: [], duration: 0 }),
    ...overrides,
  };
}

const dummyOAuthConfig = {
  clientId: "id",
  clientSecret: "secret",
  authorizeUrl: "https://example.com/auth",
  tokenUrl: "https://example.com/token",
  redirectUri: "https://example.com/callback",
  scopes: ["read"],
};

describe("getProviderAuthType", () => {
  it("returns 'file-import' for import-only providers", () => {
    const provider = stubProvider({ importOnly: true });
    expect(getProviderAuthType(provider)).toBe("file-import");
  });

  it("returns 'none' when authSetup is not defined", () => {
    const provider = stubProvider();
    expect(getProviderAuthType(provider)).toBe("none");
  });

  it("returns 'none' when authSetup returns undefined", () => {
    const provider = stubProvider({ authSetup: () => undefined });
    expect(getProviderAuthType(provider)).toBe("none");
  });

  it("returns 'none' when authSetup throws", () => {
    const provider = stubProvider({
      authSetup: () => {
        throw new Error("Missing env vars");
      },
    });
    expect(getProviderAuthType(provider)).toBe("none");
  });

  it("returns 'credential' when automatedLogin is defined", () => {
    const setup: ProviderAuthSetup = {
      oauthConfig: dummyOAuthConfig,
      exchangeCode: async () => {
        throw new Error("not supported");
      },
      automatedLogin: async () => ({
        accessToken: "tok",
        refreshToken: null,
        expiresAt: new Date(),
        scopes: null,
      }),
    };
    const provider = stubProvider({ authSetup: () => setup });
    expect(getProviderAuthType(provider)).toBe("credential");
  });

  it("returns 'oauth1' when oauth1Flow is defined", () => {
    const setup: ProviderAuthSetup = {
      oauthConfig: dummyOAuthConfig,
      exchangeCode: async () => {
        throw new Error("not supported");
      },
      oauth1Flow: {
        getRequestToken: async () => ({
          oauthToken: "t",
          oauthTokenSecret: "s",
          authorizeUrl: "https://example.com",
        }),
        exchangeForAccessToken: async () => ({ token: "t", tokenSecret: "s" }),
      },
    };
    const provider = stubProvider({ authSetup: () => setup });
    expect(getProviderAuthType(provider)).toBe("oauth1");
  });

  it("returns 'oauth' when only oauthConfig is defined", () => {
    const setup: ProviderAuthSetup = {
      oauthConfig: dummyOAuthConfig,
      exchangeCode: async () => ({
        accessToken: "tok",
        refreshToken: null,
        expiresAt: new Date(),
        scopes: null,
      }),
    };
    const provider = stubProvider({ authSetup: () => setup });
    expect(getProviderAuthType(provider)).toBe("oauth");
  });

  it("prioritizes credential over oauth when both automatedLogin and oauthConfig exist", () => {
    const setup: ProviderAuthSetup = {
      oauthConfig: dummyOAuthConfig,
      exchangeCode: async () => {
        throw new Error("not supported");
      },
      automatedLogin: async () => ({
        accessToken: "tok",
        refreshToken: null,
        expiresAt: new Date(),
        scopes: null,
      }),
    };
    const provider = stubProvider({ authSetup: () => setup });
    expect(getProviderAuthType(provider)).toBe("credential");
  });

  it("returns 'none' for UltrahumanProvider (server-side env var auth, not user credentials)", async () => {
    const { UltrahumanProvider } = await import("./ultrahuman.ts");
    const provider = new UltrahumanProvider();
    expect(getProviderAuthType(provider)).toBe("none");
  });
});
