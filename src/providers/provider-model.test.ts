import { describe, expect, it } from "vitest";
import { ProviderModel } from "./provider-model.ts";

describe("ProviderModel", () => {
  it("isConnected is true for providers without authSetup", () => {
    const model = new ProviderModel({ id: "strong-csv", name: "Strong" }, new Set());
    expect(model.isConnected).toBe(true);
    expect(model.authType).toBe("none");
  });

  it("isConnected is true for providers with authSetup that have tokens", () => {
    const model = new ProviderModel(
      { id: "strava", name: "Strava", authSetup: () => ({ oauthConfig: {} }) },
      new Set(["strava"]),
    );
    expect(model.isConnected).toBe(true);
    expect(model.authType).toBe("oauth");
  });

  it("isConnected is false for providers with authSetup that lack tokens", () => {
    const model = new ProviderModel(
      { id: "strava", name: "Strava", authSetup: () => ({ oauthConfig: {} }) },
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
          oauthConfig: { clientId: "", authorizeUrl: "", tokenUrl: "", redirectUri: "" },
          automatedLogin: async () => ({}),
        }),
      },
      new Set(),
    );
    expect(model.authType).toBe("credential");
    expect(model.isConnected).toBe(false);
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
