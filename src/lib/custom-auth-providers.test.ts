import { describe, expect, it } from "vitest";
import { providerRequiresStoredTokens } from "./custom-auth-providers.ts";

describe("providerRequiresStoredTokens", () => {
  it("requires tokens for custom-auth providers without authSetup", () => {
    expect(providerRequiresStoredTokens({ id: "whoop" })).toBe(true);
  });

  it("requires tokens for oauth providers with authSetup", () => {
    expect(providerRequiresStoredTokens({ id: "strava", authSetup: () => ({}) })).toBe(true);
  });

  it("does not require tokens for providers without auth", () => {
    expect(providerRequiresStoredTokens({ id: "intervals" })).toBe(false);
  });
});
