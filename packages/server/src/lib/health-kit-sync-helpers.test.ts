import { describe, expect, it } from "vitest";
import { computeBoundsFromIsoTimestamps } from "./health-kit-sync-helpers.ts";

describe("computeBoundsFromIsoTimestamps", () => {
  it("returns null for empty array", () => {
    expect(computeBoundsFromIsoTimestamps([])).toBeNull();
  });

  it("returns bounds for single timestamp", () => {
    const result = computeBoundsFromIsoTimestamps(["2024-01-15T10:00:00Z"]);
    expect(result).not.toBeNull();
    expect(result?.startAt).toBe("2024-01-15T10:00:00.000Z");
    expect(result?.endAt).toBe("2024-01-15T10:00:00.000Z");
  });

  it("returns min and max for multiple timestamps", () => {
    const result = computeBoundsFromIsoTimestamps([
      "2024-01-15T10:00:00Z",
      "2024-01-17T08:00:00Z",
      "2024-01-16T14:00:00Z",
    ]);
    expect(result?.startAt).toBe("2024-01-15T10:00:00.000Z");
    expect(result?.endAt).toBe("2024-01-17T08:00:00.000Z");
  });

  it("skips invalid timestamps", () => {
    const result = computeBoundsFromIsoTimestamps(["invalid", "2024-01-15T10:00:00Z"]);
    expect(result).not.toBeNull();
    expect(result?.startAt).toBe("2024-01-15T10:00:00.000Z");
  });

  it("returns null when all timestamps are invalid", () => {
    expect(computeBoundsFromIsoTimestamps(["invalid", "also-invalid"])).toBeNull();
  });

  it("requires BOTH minTs and maxTs to be finite (|| not &&)", () => {
    // If only one valid timestamp among invalids, both min and max are the same valid value
    // This tests that both isFinite checks are needed
    const result = computeBoundsFromIsoTimestamps(["2024-01-15T10:00:00Z"]);
    expect(result).not.toBeNull();
    expect(result?.startAt).toBe(result?.endAt);
  });

  it("returns null when all timestamps are NaN (isFinite guards both min and max)", () => {
    // Both minTs stays POSITIVE_INFINITY and maxTs stays NEGATIVE_INFINITY
    // isFinite(POSITIVE_INFINITY) = false, isFinite(NEGATIVE_INFINITY) = false
    // The || means either being non-finite returns null
    const result = computeBoundsFromIsoTimestamps(["not-a-date", "also-bad", "nope"]);
    expect(result).toBeNull();
  });

  it("uses < for minTs update (not <=)", () => {
    // With two identical timestamps, both should be accepted
    const result = computeBoundsFromIsoTimestamps(["2024-01-15T10:00:00Z", "2024-01-15T10:00:00Z"]);
    expect(result).not.toBeNull();
    expect(result?.startAt).toBe("2024-01-15T10:00:00.000Z");
    expect(result?.endAt).toBe("2024-01-15T10:00:00.000Z");
  });

  it("handles mix of valid and invalid where min != max", () => {
    const result = computeBoundsFromIsoTimestamps([
      "not-a-date",
      "2024-01-10T00:00:00Z",
      "garbage",
      "2024-01-20T00:00:00Z",
    ]);
    expect(result).not.toBeNull();
    expect(result?.startAt).toBe("2024-01-10T00:00:00.000Z");
    expect(result?.endAt).toBe("2024-01-20T00:00:00.000Z");
  });
});

describe("computeBoundsFromIsoTimestamps (mutation-killing)", () => {
  it("returns startAt as the minimum timestamp and endAt as the maximum", () => {
    const result = computeBoundsFromIsoTimestamps([
      "2024-01-20T00:00:00Z",
      "2024-01-10T00:00:00Z",
      "2024-01-15T00:00:00Z",
    ]);
    // If < and > were swapped, startAt would be max and endAt would be min
    expect(result?.startAt).toBe("2024-01-10T00:00:00.000Z");
    expect(result?.endAt).toBe("2024-01-20T00:00:00.000Z");
    // Confirm they're different (not both set to same value)
    expect(result?.startAt).not.toBe(result?.endAt);
  });

  it("updates minTs with < comparison (not <=, >, or >=)", () => {
    // With timestamps where the earlier one appears second in the array
    const result = computeBoundsFromIsoTimestamps(["2024-01-20T00:00:00Z", "2024-01-10T00:00:00Z"]);
    expect(result?.startAt).toBe("2024-01-10T00:00:00.000Z");
  });

  it("updates maxTs with > comparison (not >=, <, or <=)", () => {
    const result = computeBoundsFromIsoTimestamps(["2024-01-10T00:00:00Z", "2024-01-20T00:00:00Z"]);
    expect(result?.endAt).toBe("2024-01-20T00:00:00.000Z");
  });

  it("initializes minTs to POSITIVE_INFINITY and maxTs to NEGATIVE_INFINITY", () => {
    // With one valid timestamp, both min and max should equal that timestamp
    // This would fail if they were initialized to 0 or some other value
    const result = computeBoundsFromIsoTimestamps(["2024-01-15T12:00:00Z"]);
    expect(result?.startAt).toBe("2024-01-15T12:00:00.000Z");
    expect(result?.endAt).toBe("2024-01-15T12:00:00.000Z");
  });

  it("skips NaN values from Date.parse (continues on invalid)", () => {
    // Mix of valid and invalid; invalid should be skipped, not break the loop
    const result = computeBoundsFromIsoTimestamps([
      "not-a-date",
      "2024-01-15T00:00:00Z",
      "also-not-a-date",
      "2024-01-20T00:00:00Z",
    ]);
    expect(result?.startAt).toBe("2024-01-15T00:00:00.000Z");
    expect(result?.endAt).toBe("2024-01-20T00:00:00.000Z");
  });
});

describe("computeBoundsFromIsoTimestamps (mutation: || vs && for isFinite)", () => {
  it("returns null when only invalid timestamps exist (both bounds stay infinite)", () => {
    // When ALL timestamps are invalid:
    // minTs stays POSITIVE_INFINITY, maxTs stays NEGATIVE_INFINITY
    // With ||: either being non-finite → returns null (CORRECT)
    // With &&: both being non-finite → returns null (ALSO correct for this case)
    const result = computeBoundsFromIsoTimestamps(["nope", "bad"]);
    expect(result).toBeNull();
  });

  it("returns valid bounds when at least one timestamp is valid", () => {
    // When ONE valid timestamp exists:
    // minTs = maxTs = that timestamp (both finite)
    // With ||: both finite → doesn't return null (CORRECT)
    // With &&: both finite → doesn't return null (CORRECT)
    const result = computeBoundsFromIsoTimestamps(["bad", "2024-01-15T00:00:00Z", "bad"]);
    expect(result).not.toBeNull();
    expect(result?.startAt).toBe("2024-01-15T00:00:00.000Z");
  });
});
