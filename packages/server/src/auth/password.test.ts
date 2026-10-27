import { describe, expect, it } from "vitest";
import {
  hashPassword,
  InvalidPasswordError,
  normalizeEmail,
  validatePassword,
  verifyPassword,
} from "./password.ts";

describe("normalizeEmail", () => {
  it("lowercases and trims email", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
  });
});

describe("validatePassword", () => {
  it("accepts passwords meeting minimum length", () => {
    expect(() => validatePassword("12345678")).not.toThrow();
  });

  it("rejects short passwords", () => {
    expect(() => validatePassword("1234567")).toThrow(
      new InvalidPasswordError("Use at least 8 characters."),
    );
  });

  it("rejects passwords longer than the maximum", () => {
    expect(() => validatePassword("a".repeat(129))).toThrow(
      new InvalidPasswordError("Use no more than 128 characters."),
    );
  });
});

describe("hashPassword", () => {
  it("returns a scrypt hash that verifies", () => {
    const hash = hashPassword("super-secret-password");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("super-secret-password", hash)).toBe(true);
    expect(verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("embeds scrypt parameters in the stored hash", () => {
    const hash = hashPassword("super-secret-password");
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
  });

  it("rejects weak passwords", () => {
    expect(() => hashPassword("short")).toThrow(InvalidPasswordError);
  });
});

describe("verifyPassword", () => {
  it("returns false for malformed stored hashes", () => {
    expect(verifyPassword("password", "not-a-valid-hash")).toBe(false);
  });

  it("returns false when the hash prefix is not scrypt", () => {
    const hash = hashPassword("super-secret-password").replace("scrypt", "bcrypt");
    expect(verifyPassword("super-secret-password", hash)).toBe(false);
  });

  it("returns false when the hash has the wrong number of parts", () => {
    expect(verifyPassword("password", "scrypt$16384$8$1$salt")).toBe(false);
  });

  it("returns false when scrypt parameters are missing", () => {
    expect(verifyPassword("password", "scrypt$$8$1$salt$abcd")).toBe(false);
  });

  it("returns false when scrypt parameters are not numeric", () => {
    const hash = hashPassword("super-secret-password");
    const [, , , , salt, expected] = hash.split("$");
    expect(verifyPassword("password", `scrypt$NaN$8$1$${salt}$${expected}`)).toBe(false);
  });

  it("returns false when the derived hash length does not match", () => {
    const hash = hashPassword("super-secret-password");
    const truncated = hash.slice(0, -2);
    expect(verifyPassword("super-secret-password", truncated)).toBe(false);
  });
});
