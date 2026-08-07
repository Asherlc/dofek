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
  it("returns credential-only auth setup", () => {
    const provider = new EightSleepProvider();
    const setup = provider.authSetup();

    expect(setup.automatedLogin).toBeTypeOf("function");
    expect(setup.oauthConfig).toBeUndefined();
    expect(setup.exchangeCode).toBeUndefined();
  });
});
