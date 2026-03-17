import { describe, expect, it, vi } from "vitest";
import {
  formatDateForDisplay,
  formatDateForQuery,
  formatRelativeTime,
  formatTime,
  isToday,
} from "./dates.ts";

describe("formatDateForDisplay", () => {
  it("formats a date with weekday, month, day, and year", () => {
    const date = new Date("2026-03-15T12:00:00Z");
    const result = formatDateForDisplay(date);
    expect(result).toContain("Mar");
    expect(result).toContain("15");
    expect(result).toContain("2026");
  });
});

describe("formatDateForQuery", () => {
  it("formats a date as YYYY-MM-DD", () => {
    const date = new Date(2026, 2, 5); // March 5, 2026 (local)
    expect(formatDateForQuery(date)).toBe("2026-03-05");
  });

  it("zero-pads single-digit months and days", () => {
    const date = new Date(2026, 0, 3); // January 3, 2026 (local)
    expect(formatDateForQuery(date)).toBe("2026-01-03");
  });
});

describe("isToday", () => {
  it("returns true for today", () => {
    expect(isToday(new Date())).toBe(true);
  });

  it("returns false for yesterday", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(isToday(yesterday)).toBe(false);
  });

  it("returns false for a different year", () => {
    const pastDate = new Date(2020, 0, 1);
    expect(isToday(pastDate)).toBe(false);
  });
});

describe("formatRelativeTime", () => {
  it("returns 'just now' for times less than a minute ago", () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe("just now");
  });

  it("returns minutes ago for times less than an hour ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T12:30:00Z"));
    expect(formatRelativeTime("2026-03-15T12:10:00Z")).toBe("20m ago");
    vi.useRealTimers();
  });

  it("returns hours ago for times less than 24 hours ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T15:00:00Z"));
    expect(formatRelativeTime("2026-03-15T12:00:00Z")).toBe("3h ago");
    vi.useRealTimers();
  });

  it("returns days ago for times 24+ hours ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T12:00:00Z"));
    expect(formatRelativeTime("2026-03-15T12:00:00Z")).toBe("2d ago");
    vi.useRealTimers();
  });
});

describe("formatTime", () => {
  it("formats an ISO string as a localized time", () => {
    const result = formatTime("2026-03-15T15:30:00Z");
    // The exact output depends on timezone, but it should contain key parts
    expect(result).toContain("Mar");
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });
});
