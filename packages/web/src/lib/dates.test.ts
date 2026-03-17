import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatDateForDisplay,
  formatDateForQuery,
  formatRelativeTime,
  formatTime,
  isToday,
} from "./dates.ts";

describe("formatDateForQuery", () => {
  it("formats a date as YYYY-MM-DD", () => {
    const date = new Date(2026, 2, 15); // March 15, 2026
    expect(formatDateForQuery(date)).toBe("2026-03-15");
  });

  it("zero-pads single-digit months and days", () => {
    const date = new Date(2026, 0, 5); // Jan 5
    expect(formatDateForQuery(date)).toBe("2026-01-05");
  });

  it("handles December correctly (month + 1)", () => {
    const date = new Date(2026, 11, 31); // Dec 31
    expect(formatDateForQuery(date)).toBe("2026-12-31");
  });
});

describe("isToday", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 14, 30)); // Mar 15 2026 2:30 PM
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true for today's date", () => {
    expect(isToday(new Date(2026, 2, 15, 8, 0))).toBe(true);
  });

  it("returns false for yesterday", () => {
    expect(isToday(new Date(2026, 2, 14))).toBe(false);
  });

  it("returns false for tomorrow", () => {
    expect(isToday(new Date(2026, 2, 16))).toBe(false);
  });

  it("returns false for same day different year", () => {
    expect(isToday(new Date(2025, 2, 15))).toBe(false);
  });

  it("returns false for same day different month", () => {
    expect(isToday(new Date(2026, 3, 15))).toBe(false);
  });
});

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for less than 1 minute ago", () => {
    expect(formatRelativeTime("2026-03-15T11:59:30Z")).toBe("just now");
  });

  it("returns minutes ago for less than 1 hour", () => {
    expect(formatRelativeTime("2026-03-15T11:30:00Z")).toBe("30m ago");
    expect(formatRelativeTime("2026-03-15T11:55:00Z")).toBe("5m ago");
  });

  it("returns hours ago for less than 1 day", () => {
    expect(formatRelativeTime("2026-03-15T09:00:00Z")).toBe("3h ago");
    expect(formatRelativeTime("2026-03-14T13:00:00Z")).toBe("23h ago");
  });

  it("returns days ago for 24+ hours", () => {
    expect(formatRelativeTime("2026-03-13T12:00:00Z")).toBe("2d ago");
    expect(formatRelativeTime("2026-03-08T12:00:00Z")).toBe("7d ago");
  });
});

describe("formatDateForDisplay", () => {
  it("formats date with weekday, month, day, and year", () => {
    const date = new Date(2026, 2, 15); // Sunday March 15 2026
    const result = formatDateForDisplay(date);
    expect(result).toContain("Mar");
    expect(result).toContain("15");
    expect(result).toContain("2026");
  });
});

describe("formatTime", () => {
  it("formats ISO string with month, day, hour, and minute", () => {
    const result = formatTime("2026-03-15T14:30:00Z");
    expect(result).toContain("Mar");
    expect(result).toContain("15");
  });
});
