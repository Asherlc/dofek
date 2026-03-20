import { describe, expect, it } from "vitest";
import { ProviderModel } from "./provider-model.ts";

describe("ProviderModel", () => {
  it("isConnected is true for providers without authSetup", () => {
    const model = new ProviderModel({ id: "strong-csv", name: "Strong" }, new Set());
    expect(model.isConnected).toBe(true);
    expect(model.needsOAuth).toBe(false);
    expect(model.needsCustomAuth).toBe(false);
  });

  it("isConnected is true for providers with authSetup that have tokens", () => {
    const model = new ProviderModel(
      { id: "strava", name: "Strava", authSetup: () => ({ oauthConfig: {} }) },
      new Set(["strava"]),
    );
    expect(model.isConnected).toBe(true);
    expect(model.needsOAuth).toBe(true);
    expect(model.needsCustomAuth).toBe(false);
  });

  it("isConnected is false for providers with authSetup that lack tokens", () => {
    const model = new ProviderModel(
      { id: "strava", name: "Strava", authSetup: () => ({ oauthConfig: {} }) },
      new Set(),
    );
    expect(model.isConnected).toBe(false);
  });

  it("needsCustomAuth is true for providers with authSetup but no oauthConfig", () => {
    const model = new ProviderModel(
      { id: "whoop", name: "WHOOP", authSetup: () => undefined },
      new Set(),
    );
    expect(model.needsCustomAuth).toBe(true);
    expect(model.needsOAuth).toBe(false);
    expect(model.isConnected).toBe(false);
  });

  it("sets both needsOAuth and needsCustomAuth for dual-auth providers", () => {
    const model = new ProviderModel(
      {
        id: "garmin",
        name: "Garmin",
        authSetup: () => ({
          oauthConfig: { clientId: "garmin", authorizeUrl: "", tokenUrl: "", redirectUri: "" },
          automatedLogin: async () => ({}),
        }),
      },
      new Set(["garmin"]),
    );
    expect(model.needsOAuth).toBe(true);
    expect(model.needsCustomAuth).toBe(true);
    expect(model.isConnected).toBe(true);
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
    expect(model.needsOAuth).toBe(false);
    expect(model.needsCustomAuth).toBe(true);
    expect(model.isConnected).toBe(false);
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
});
