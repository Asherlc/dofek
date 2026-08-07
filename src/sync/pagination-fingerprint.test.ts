import { describe, expect, it } from "vitest";
import { fingerprintOpaqueValue } from "./pagination-fingerprint.ts";

describe("fingerprintOpaqueValue", () => {
  it("returns null for absent values", () => {
    expect(fingerprintOpaqueValue(null)).toBeNull();
    expect(fingerprintOpaqueValue(undefined)).toBeNull();
  });

  it("returns a stable 12-character SHA-256 prefix for opaque cursors", () => {
    expect(fingerprintOpaqueValue("page-token")).toBe("8e6780cc7aa5");
    expect(fingerprintOpaqueValue(42)).toBe("73475cb40a56");
  });
});
