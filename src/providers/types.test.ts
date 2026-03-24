import { describe, expect, it } from "vitest";
import type { Provider, ProviderAuthSetup } from "./types.ts";
import { getProviderAuthType, isSyncProvider, isWebhookProvider } from "./types.ts";

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

describe("isWebhookProvider", () => {
  it("returns false for a plain SyncProvider without registerWebhook", () => {
    const provider = stubProvider();
    expect(isWebhookProvider(provider)).toBe(false);
  });

  it("returns true when registerWebhook is a function", () => {
    // Use a real WebhookProvider-like object to test the type guard
    const webhookProvider: Provider = {
      id: "wh-test",
      name: "WH Test",
      validate: () => null,
      sync: async () => ({ provider: "wh-test", recordsSynced: 0, errors: [], duration: 0 }),
    };
    // Add webhook methods to simulate a WebhookProvider at runtime
    Object.assign(webhookProvider, {
      registerWebhook: async () => ({ subscriptionId: "sub" }),
      unregisterWebhook: async () => {},
      verifyWebhookSignature: () => true,
      parseWebhookPayload: () => [],
      webhookScope: "app",
    });
    expect(isWebhookProvider(webhookProvider)).toBe(true);
  });

  it("returns false for ImportProvider", () => {
    const importProvider: Provider = {
      id: "csv-import",
      name: "CSV Import",
      validate: () => null,
      importOnly: true,
    };
    expect(isWebhookProvider(importProvider)).toBe(false);
  });

  it("returns false when registerWebhook property exists but is not a function", () => {
    const provider: Provider = {
      id: "broken",
      name: "Broken",
      validate: () => null,
      sync: async () => ({ provider: "broken", recordsSynced: 0, errors: [], duration: 0 }),
    };
    // Simulate a malformed provider with registerWebhook as a string
    Object.assign(provider, { registerWebhook: "string-not-function" });
    expect(isWebhookProvider(provider)).toBe(false);
  });
});

describe("isSyncProvider", () => {
  it("returns true for a regular SyncProvider", () => {
    const provider = stubProvider();
    expect(isSyncProvider(provider)).toBe(true);
  });

  it("returns false for an ImportProvider with importOnly: true", () => {
    const importProvider: Provider = {
      id: "csv",
      name: "CSV",
      validate: () => null,
      importOnly: true,
    };
    expect(isSyncProvider(importProvider)).toBe(false);
  });

  it("returns true for a provider without importOnly property", () => {
    const provider = stubProvider();
    expect(isSyncProvider(provider)).toBe(true);
    // Verify type guard works: after narrowing, sync is accessible
    if (isSyncProvider(provider)) {
      expect(typeof provider.sync).toBe("function");
    }
  });
});
