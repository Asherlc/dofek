import { describe, expect, it } from "vitest";
import { EightSleepProvider } from "./eight-sleep.ts";

// ============================================================
// Extended Eight Sleep tests covering EightSleepProvider
// validate and authSetup methods
// ============================================================

describe("EightSleepProvider — basic properties", () => {
  it("has correct id and name", () => {
    const provider = new EightSleepProvider();
    expect(provider.id).toBe("eight-sleep");
    expect(provider.name).toBe("Eight Sleep");
  });

  it("validate always returns null (always enabled)", () => {
    const provider = new EightSleepProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("EightSleepProvider — authSetup", () => {
  it("returns auth setup with correct oauthConfig", () => {
    const provider = new EightSleepProvider();
    const setup = provider.authSetup();

    expect(setup.oauthConfig.authorizeUrl).toContain("8slp.net");
    expect(setup.oauthConfig.tokenUrl).toContain("8slp.net");
    expect(setup.oauthConfig.redirectUri).toBe("");
    expect(setup.oauthConfig.scopes).toEqual([]);
  });

  it("has automatedLogin function", () => {
    const provider = new EightSleepProvider();
    const setup = provider.authSetup();
    expect(setup.automatedLogin).toBeTypeOf("function");
  });

  it("exchangeCode throws (not supported)", async () => {
    const provider = new EightSleepProvider();
    const setup = provider.authSetup();
    await expect(setup.exchangeCode("code")).rejects.toThrow("automated login");
  });
});
