import { describe, expect, it } from "vitest";
import { canonicalizeTimestampForExternalId } from "./canonical-timestamp.ts";

describe("canonicalizeTimestampForExternalId", () => {
  it("normalizes equivalent timestamp strings to the same ISO representation", () => {
    expect(canonicalizeTimestampForExternalId("2026-03-30T12:00:00Z")).toBe(
      "2026-03-30T12:00:00.000Z",
    );
    expect(canonicalizeTimestampForExternalId("2026-03-30T05:00:00-07:00")).toBe(
      "2026-03-30T12:00:00.000Z",
    );
  });

  it("rejects invalid timestamps before composing external IDs", () => {
    expect(() => canonicalizeTimestampForExternalId("not-a-timestamp")).toThrow(
      "Invalid timestamp for external ID: not-a-timestamp",
    );
  });

  it("rejects timezone-less timestamps before composing external IDs", () => {
    expect(() => canonicalizeTimestampForExternalId("2026-03-30T12:00:00")).toThrow(
      "Invalid timestamp for external ID: 2026-03-30T12:00:00",
    );
  });
});
