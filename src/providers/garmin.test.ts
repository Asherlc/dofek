import { describe, expect, it } from "vitest";
import { GarminProvider } from "./garmin.ts";

// ============================================================
// Provider identity
// ============================================================

describe("GarminProvider — provider identity", () => {
  it("has id 'garmin'", () => {
    const provider = new GarminProvider();
    expect(provider.id).toBe("garmin");
  });

  it("has name 'Garmin Connect'", () => {
    const provider = new GarminProvider();
    expect(provider.name).toBe("Garmin Connect");
  });
});

// ============================================================
// Validation
// ============================================================

describe("GarminProvider.validate()", () => {
  it("always returns null (no env vars required)", () => {
    const provider = new GarminProvider();
    expect(provider.validate()).toBeNull();
  });
});

// ============================================================
// Auth setup
// ============================================================

describe("GarminProvider.authSetup()", () => {
  it("provides automatedLogin function", () => {
    const provider = new GarminProvider();
    const setup = provider.authSetup();
    expect(setup.automatedLogin).toBeTypeOf("function");
  });

  it("uses a dummy OAuth config (internal API only)", () => {
    const provider = new GarminProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("garmin-connect-internal");
    expect(setup.oauthConfig.authorizeUrl).toBe("");
    expect(setup.oauthConfig.tokenUrl).toBe("");
    expect(setup.oauthConfig.redirectUri).toBe("");
    expect(setup.oauthConfig.scopes).toEqual([]);
  });

  it("exchangeCode always rejects (credential-only)", async () => {
    const provider = new GarminProvider();
    const setup = provider.authSetup();
    await expect(setup.exchangeCode("some-code")).rejects.toThrow(
      "Garmin uses credential-based sign-in",
    );
  });
});
