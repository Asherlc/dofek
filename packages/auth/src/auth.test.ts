import { describe, expect, it } from "vitest";
import {
  AuthUserSchema,
  ConfiguredProvidersSchema,
  getEmailValidationError,
  getNewPasswordValidationError,
  IDENTITY_PROVIDER_NAMES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENT_TEXT,
} from "./auth";

describe("IDENTITY_PROVIDER_NAMES", () => {
  it("contains the expected providers", () => {
    expect(IDENTITY_PROVIDER_NAMES).toEqual(["google", "apple"]);
  });

  it("is readonly", () => {
    // Type check: should be readonly tuple
    const names: readonly string[] = IDENTITY_PROVIDER_NAMES;
    expect(names).toHaveLength(2);
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

  it("accepts nativeApple flag", () => {
    const result = ConfiguredProvidersSchema.parse({
      identity: ["apple"],
      data: [],
      nativeApple: true,
    });
    expect(result.nativeApple).toBe(true);
  });

  it("defaults nativeApple to undefined when omitted", () => {
    const result = ConfiguredProvidersSchema.parse({
      identity: [],
      data: [],
    });
    expect(result.nativeApple).toBeUndefined();
  });

  it("accepts password flag", () => {
    const result = ConfiguredProvidersSchema.parse({
      identity: [],
      data: [],
      password: true,
    });
    expect(result.password).toBe(true);
  });
});

describe("getEmailValidationError", () => {
  it("requires an email address", () => {
    expect(getEmailValidationError("   ")).toBe("Enter your email address.");
  });

  it("rejects malformed email addresses", () => {
    expect(getEmailValidationError("not-an-email")).toBe("Enter a valid email address.");
  });

  it("accepts a trimmed email address", () => {
    expect(getEmailValidationError("  athlete@example.com ")).toBeNull();
  });
});

describe("getNewPasswordValidationError", () => {
  it("matches the existing server password boundaries", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
    expect(PASSWORD_REQUIREMENT_TEXT).toBe("Use 8–128 characters.");
  });

  it("rejects passwords below the minimum length", () => {
    expect(getNewPasswordValidationError("a".repeat(PASSWORD_MIN_LENGTH - 1))).toBe(
      "Use at least 8 characters.",
    );
  });

  it("accepts passwords at both length boundaries", () => {
    expect(getNewPasswordValidationError("a".repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(getNewPasswordValidationError("a".repeat(PASSWORD_MAX_LENGTH))).toBeNull();
  });

  it("rejects passwords above the maximum length", () => {
    expect(getNewPasswordValidationError("a".repeat(PASSWORD_MAX_LENGTH + 1))).toBe(
      "Use no more than 128 characters.",
    );
  });
});
