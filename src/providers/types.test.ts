import { describe, expect, it } from "vitest";
import type { Provider, ProviderAuthSetup } from "./types.ts";
import { getProviderAuthTypeFromSetup, isSyncProvider, isWebhookProvider } from "./types.ts";

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

describe("getProviderAuthTypeFromSetup", () => {
  it("returns 'none' when authSetup is not defined", () => {
    const provider = stubProvider();
    expect(getProviderAuthTypeFromSetup(provider.authSetup?.())).toBe("none");
  });

  it("returns 'none' when authSetup returns undefined", () => {
    const provider = stubProvider({ authSetup: () => undefined });
    expect(getProviderAuthTypeFromSetup(provider.authSetup?.())).toBe("none");
  });

  it("returns 'none' when authSetup returns an empty setup", () => {
    const provider = stubProvider({ authSetup: () => ({}) });
    expect(getProviderAuthTypeFromSetup(provider.authSetup?.())).toBe("none");
  });

  it("returns 'credential' when automatedLogin is defined", () => {
    const setup: ProviderAuthSetup = {
      automatedLogin: async () => ({
        accessToken: "tok",
        refreshToken: null,
        expiresAt: new Date(),
        scopes: null,
      }),
    };
    const provider = stubProvider({ authSetup: () => setup });
    expect(getProviderAuthTypeFromSetup(provider.authSetup?.())).toBe("credential");
  });

  it("returns 'token' when manual token authentication is defined", () => {
    const setup: ProviderAuthSetup = {
      manualToken: {
        label: "Personal API token",
        instructionsUrl: "https://example.com/settings/api-token",
        exchangeToken: async () => ({
          accessToken: "tok",
          refreshToken: null,
          expiresAt: new Date(),
          scopes: "read",
        }),
      },
    };
    const provider = stubProvider({ authSetup: () => setup });
    expect(getProviderAuthTypeFromSetup(provider.authSetup?.())).toBe("token");
  });

  it("prioritizes personal token auth when OAuth is also configured", () => {
    const setup: ProviderAuthSetup = {
      oauthConfig: dummyOAuthConfig,
      exchangeCode: async () => ({
        accessToken: "oauth-token",
        refreshToken: null,
        expiresAt: new Date(),
        scopes: null,
      }),
      manualToken: {
        label: "Personal API token",
        instructionsUrl: "https://example.com/settings/api-token",
        exchangeToken: async () => ({
          accessToken: "personal-token",
          refreshToken: null,
          expiresAt: new Date(),
          scopes: "read",
        }),
      },
    };
    const provider = stubProvider({ authSetup: () => setup });

    expect(getProviderAuthTypeFromSetup(provider.authSetup?.())).toBe("token");
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
    expect(getProviderAuthTypeFromSetup(provider.authSetup?.())).toBe("oauth1");
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
    expect(getProviderAuthTypeFromSetup(provider.authSetup?.())).toBe("oauth");
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
    expect(getProviderAuthTypeFromSetup(provider.authSetup?.())).toBe("credential");
  });

  it("returns 'token' for UltrahumanProvider", async () => {
    const { UltrahumanProvider } = await import("./ultrahuman.ts");
    const provider = new UltrahumanProvider();
    expect(getProviderAuthTypeFromSetup(provider.authSetup?.())).toBe("token");
  });

  it("returns 'credential' for AmazfitZeppProvider", async () => {
    const { AmazfitZeppProvider } = await import("./amazfit-zepp.ts");
    const provider = new AmazfitZeppProvider();
    expect(getProviderAuthTypeFromSetup(provider.authSetup?.())).toBe("credential");
  });

  it("returns 'oauth' when setup has oauthConfig but nothing else", () => {
    // Ensures the oauthConfig check on line 289 actually fires and returns 'oauth'
    // (if oauthConfig were mutated away, this would return 'none' instead)
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
    // Must be 'oauth', NOT 'none'
    expect(getProviderAuthTypeFromSetup(provider.authSetup?.())).toBe("oauth");
  });

  it("returns exact string 'none' (not empty) when no auth setup exists", () => {
    const provider = stubProvider({ authSetup: undefined });
    const result = getProviderAuthTypeFromSetup(provider.authSetup?.());
    expect(result).toBe("none");
    expect(result).not.toBe("");
    expect(result.length).toBe(4);
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
