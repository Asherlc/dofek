import { describe, expect, it } from "vitest";
import { clickHouseStringLiteral, clickHouseDateTimeLiteral, parsePostgresTimestamp } from "./sql.ts";

describe("clickHouseStringLiteral", () => {
  it("wraps a plain string in single quotes", () => {
    expect(clickHouseStringLiteral("hello")).toBe("'hello'");
  });

  it("escapes single quotes inside the value", () => {
    expect(clickHouseStringLiteral("he'llo")).toBe("'he\\'llo'");
  });

  it("escapes backslashes inside the value", () => {
    expect(clickHouseStringLiteral("he\\llo")).toBe("'he\\\\llo'");
  });
});

describe("clickHouseDateTimeLiteral", () => {
  it("formats a UTC date as toDateTime64 with 6-digit precision", () => {
    const date = new Date("2026-05-30T12:34:56.789000Z");
    const result = clickHouseDateTimeLiteral(date);
    expect(result).toBe("toDateTime64('2026-05-30 12:34:56.789', 6, 'UTC')");
  });

  it("strips trailing zeros from the ISO milliseconds", () => {
    const date = new Date("2026-05-30T12:00:00.000000Z");
    const result = clickHouseDateTimeLiteral(date);
    expect(result).toBe("toDateTime64('2026-05-30 12:00:00.000', 6, 'UTC')");
  });
});

describe("parsePostgresTimestamp", () => {
  it("parses UTC timestamp ending in Z", () => {
    const result = parsePostgresTimestamp("2026-05-30T12:34:56.789Z", "test");
    expect(result.toISOString()).toBe("2026-05-30T12:34:56.789Z");
  });

  it("parses timestamp with positive offset", () => {
    const result = parsePostgresTimestamp("2026-05-30T12:34:56.789+05:00", "test");
    expect(result.toISOString()).toBe("2026-05-30T07:34:56.789Z");
  });

  it("parses timestamp with negative offset", () => {
    const result = parsePostgresTimestamp("2026-05-30T12:34:56.789-05:00", "test");
    expect(result.toISOString()).toBe("2026-05-30T17:34:56.789Z");
  });

  it("parses timestamp with compact offset (no colon)", () => {
    const result = parsePostgresTimestamp("2026-05-30T12:34:56.789+0500", "test");
    expect(result.toISOString()).toBe("2026-05-30T07:34:56.789Z");
  });

  it("normalizes space-separated postgres timestamp to T separator", () => {
    const result = parsePostgresTimestamp("2026-05-30 12:34:56.789", "test");
    expect(result.toISOString()).toBe("2026-05-30T12:34:56.789Z");
  });

  it("throws on invalid date string", () => {
    expect(() => parsePostgresTimestamp("not-a-date", "test-label")).toThrow("Invalid test-label: not-a-date");
  });

  it("throws on NaN date", () => {
    expect(() => parsePostgresTimestamp("2026-13-01T00:00:00Z", "test-label")).toThrow("Invalid test-label: 2026-13-01T00:00:00Z");
  });
});
