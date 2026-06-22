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
    expect(() => validatePassword("short")).toThrow(InvalidPasswordError);
  });
});

describe("hashPassword", () => {
  it("returns a scrypt hash that verifies", () => {
    const hash = hashPassword("super-secret-password");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("super-secret-password", hash)).toBe(true);
    expect(verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("rejects weak passwords", () => {
    expect(() => hashPassword("short")).toThrow(InvalidPasswordError);
  });
});

describe("verifyPassword", () => {
  it("returns false for malformed stored hashes", () => {
    expect(verifyPassword("password", "not-a-valid-hash")).toBe(false);
  });
});
