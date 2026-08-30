import { afterEach, describe, expect, it, vi } from "vitest";
import { CyclingAnalyticsProvider } from "./cycling-analytics.ts";
import { ProviderModel, providerTokenAuthSchema } from "./provider-model.ts";

describe("ProviderModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["not-a-url", "http://example.com/token"])(
    "rejects a non-HTTPS token URL at the shared schema boundary: %s",
    (instructionsUrl) => {
      const result = providerTokenAuthSchema.safeParse({
        label: "Personal token",
        instructionsUrl,
      });
      expect(result.success).toBe(false);
    },
  );

  it("isConnected is true for providers without authSetup", () => {
    const model = new ProviderModel({ id: "strong-csv", name: "Strong" }, new Set());
    expect(model.isConnected).toBe(true);
    expect(model.authType).toBe("none");
  });

  it("isConnected is true for providers with authSetup that have tokens", () => {
    const model = new ProviderModel(
      {
        id: "strava",
        name: "Strava",
        authSetup: () => ({ oauthConfig: {}, exchangeCode: async () => ({}) }),
      },
      new Set(["strava"]),
    );
    expect(model.isConnected).toBe(true);
    expect(model.authType).toBe("oauth");
  });

  it("isConnected is false for providers with authSetup that lack tokens", () => {
    const model = new ProviderModel(
      {
        id: "strava",
        name: "Strava",
        authSetup: () => ({ oauthConfig: {}, exchangeCode: async () => ({}) }),
      },
      new Set(),
    );
    expect(model.isConnected).toBe(false);
  });

  it("authType is 'none' for providers with authSetup but no recognizable config", () => {
    const model = new ProviderModel(
      { id: "whoop", name: "WHOOP", authSetup: () => undefined },
      new Set(),
    );
    expect(model.authType).toBe("none");
    expect(model.isConnected).toBe(true);
  });

  it("authType is 'credential' for providers with automatedLogin", () => {
    const model = new ProviderModel(
      {
        id: "eight-sleep",
        name: "Eight Sleep",
        authSetup: () => ({
          automatedLogin: async () => ({}),
        }),
      },
      new Set(),
    );
    expect(model.authType).toBe("credential");
    expect(model.isConnected).toBe(false);
  });

  it("does not classify OAuth metadata without an authorization-code exchanger", () => {
    const model = new ProviderModel(
      {
        id: "incomplete-oauth",
        name: "Incomplete OAuth",
        authSetup: () => ({ oauthConfig: {} }),
      },
      new Set(),
    );

    expect(model.authType).toBe("none");
  });

  it("exposes manual token connection metadata", () => {
    const model = new ProviderModel(
      {
        id: "personal-token-provider",
        name: "Personal Token Provider",
        authSetup: () => ({
          manualToken: {
            label: "Refresh token",
            instructionsUrl: "https://example.com/settings/api-key",
            exchangeToken: async () => ({}),
          },
        }),
      },
      new Set(),
    );

    expect(model.authType).toBe("token");
    expect(model.isConnected).toBe(false);
    expect(model.tokenAuth).toEqual({
      label: "Refresh token",
      instructionsUrl: "https://example.com/settings/api-key",
    });
  });

  it.each([
    { configuredOAuth: false, clientId: "", clientSecret: "" },
    { configuredOAuth: true, clientId: "client-id", clientSecret: "client-secret" },
  ])(
    "exposes Cycling Analytics personal-token auth when OAuth configured is $configuredOAuth",
    ({ clientId, clientSecret }) => {
      vi.stubEnv("CYCLING_ANALYTICS_CLIENT_ID", clientId);
      vi.stubEnv("CYCLING_ANALYTICS_CLIENT_SECRET", clientSecret);

      const model = new ProviderModel(new CyclingAnalyticsProvider(), new Set());

      expect(model.authType).toBe("token");
      expect(model.tokenAuth).toEqual({
        label: "Personal API token",
        instructionsUrl: "https://www.cyclinganalytics.com/developer/api/authentication",
      });
    },
  );

  it.each(["javascript:alert('xss')", "http://example.com/token", "not-a-url"])(
    "does not expose an unsafe manual token instructions URL: %s",
    (instructionsUrl) => {
      const model = new ProviderModel(
        {
          id: "unsafe-token-provider",
          name: "Unsafe Token Provider",
          authSetup: () => ({
            manualToken: {
              label: "Personal token",
              instructionsUrl,
              exchangeToken: async () => ({}),
            },
          }),
        },
        new Set(),
      );

      expect(model.authType).toBe("none");
      expect(model.tokenAuth).toBeNull();
    },
  );

  it.each([
    {},
    { manualToken: "token" },
    { manualToken: null },
    { manualToken: {} },
    {
      manualToken: {
        label: 123,
        instructionsUrl: "https://example.com/token",
      },
    },
    {
      manualToken: {
        label: "Personal token",
      },
    },
    {
      manualToken: {
        label: "Personal token",
        instructionsUrl: new URL("https://example.com/token"),
      },
    },
  ])("does not expose malformed manual token metadata: %j", (setup) => {
    const model = new ProviderModel(
      {
        id: "malformed-token-provider",
        name: "Malformed Token Provider",
        authSetup: () => setup,
      },
      new Set(),
    );

    expect(model.authType).toBe("none");
    expect(model.tokenAuth).toBeNull();
  });

  it("applies customAuthOverrides when provided", () => {
    const model = new ProviderModel(
      { id: "whoop", name: "WHOOP", authSetup: () => undefined },
      new Set(["whoop"]),
      undefined,
      { whoop: "custom:whoop" },
    );
    expect(model.authType).toBe("custom:whoop");
    expect(model.isConnected).toBe(true);
  });

  it("custom auth override makes provider require auth", () => {
    const model = new ProviderModel(
      { id: "garmin", name: "Garmin", authSetup: () => undefined },
      new Set(),
      undefined,
      { garmin: "custom:garmin" },
    );
    expect(model.authType).toBe("custom:garmin");
    expect(model.isConnected).toBe(false);
  });

  it("handles authSetup that throws", () => {
    const model = new ProviderModel(
      {
        id: "broken",
        name: "Broken",
        authSetup: () => {
          throw new Error("no credentials");
        },
      },
      new Set(),
    );
    expect(model.authType).toBe("none");
    expect(model.isConnected).toBe(true);
  });

  it("reads lastSyncedAt from the map", () => {
    const model = new ProviderModel(
      { id: "wahoo", name: "Wahoo" },
      new Set(),
      new Map([["wahoo", "2024-01-01"]]),
    );
    expect(model.lastSyncedAt).toBe("2024-01-01");
  });

  it("lastSyncedAt is null when not in the map", () => {
    const model = new ProviderModel({ id: "wahoo", name: "Wahoo" }, new Set());
    expect(model.lastSyncedAt).toBeNull();
  });

  it("authType is 'file-import' for import-only providers", () => {
    const model = new ProviderModel(
      { id: "strong-csv", name: "Strong", importOnly: true },
      new Set(),
    );
    expect(model.authType).toBe("file-import");
    expect(model.importOnly).toBe(true);
    expect(model.isConnected).toBe(true);
  });

  it("authType is 'oauth1' for providers with oauth1Flow", () => {
    const model = new ProviderModel(
      {
        id: "fatsecret",
        name: "FatSecret",
        authSetup: () => ({
          oauthConfig: {},
          oauth1Flow: {
            getRequestToken: async () => ({}),
            exchangeForAccessToken: async () => ({}),
          },
        }),
      },
      new Set(),
    );
    expect(model.authType).toBe("oauth1");
  });
});
