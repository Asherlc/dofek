import { describe, expect, it } from "vitest";
import { AuthUserSchema, ConfiguredProvidersSchema, IDENTITY_PROVIDER_NAMES } from "./auth";

describe("IDENTITY_PROVIDER_NAMES", () => {
  it("contains the expected providers", () => {
    expect(IDENTITY_PROVIDER_NAMES).toEqual(["google", "apple", "authentik"]);
  });

  it("is readonly", () => {
    // Type check: should be readonly tuple
    const names: readonly string[] = IDENTITY_PROVIDER_NAMES;
    expect(names).toHaveLength(3);
  });
});

describe("AuthUserSchema", () => {
  it("parses a valid user", () => {
    const result = AuthUserSchema.parse({
      id: "usr_123",
      name: "Alice",
      email: "alice@example.com",
    });
    expect(result).toEqual({
      id: "usr_123",
      name: "Alice",
      email: "alice@example.com",
    });
  });

  it("accepts null email", () => {
    const result = AuthUserSchema.parse({
      id: "usr_123",
      name: "Alice",
      email: null,
    });
    expect(result.email).toBeNull();
  });

  it("rejects missing fields", () => {
    expect(() => AuthUserSchema.parse({ id: "usr_123" })).toThrow();
  });

  it("rejects wrong types", () => {
    expect(() => AuthUserSchema.parse({ id: 123, name: "Alice", email: null })).toThrow();
  });
});

describe("ConfiguredProvidersSchema", () => {
  it("parses valid providers", () => {
    const result = ConfiguredProvidersSchema.parse({
      identity: ["google", "apple"],
      data: ["strava", "wahoo"],
    });
    expect(result.identity).toEqual(["google", "apple"]);
    expect(result.data).toEqual(["strava", "wahoo"]);
  });

  it("rejects unknown identity providers", () => {
    expect(() =>
      ConfiguredProvidersSchema.parse({
        identity: ["unknown_provider"],
        data: [],
      }),
    ).toThrow();
  });

  it("accepts empty arrays", () => {
    const result = ConfiguredProvidersSchema.parse({
      identity: [],
      data: [],
    });
    expect(result.identity).toEqual([]);
    expect(result.data).toEqual([]);
  });
});
