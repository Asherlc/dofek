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

  it("includes a short weekday name", () => {
    // Wednesday
    const date = new Date(2026, 0, 7);
    const result = formatDateForDisplay(date);
    expect(result).toContain("Wed");
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

  it("formats double-digit months and days without extra padding", () => {
    const date = new Date(2026, 11, 25); // December 25, 2026
    expect(formatDateForQuery(date)).toBe("2026-12-25");
  });

  it("uses hyphen separators", () => {
    const result = formatDateForQuery(new Date(2026, 5, 15));
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

  it("returns false for same day different month", () => {
    const now = new Date();
    const differentMonth = new Date(now.getFullYear(), (now.getMonth() + 1) % 12, now.getDate());
    expect(isToday(differentMonth)).toBe(false);
  });

  it("returns false for tomorrow", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(isToday(tomorrow)).toBe(false);
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

  it("returns 1m at exactly 60 seconds ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T12:01:00Z"));
    expect(formatRelativeTime("2026-03-15T12:00:00Z")).toBe("1m ago");
    vi.useRealTimers();
  });

  it("returns 59m at 59 minutes ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T12:59:00Z"));
    expect(formatRelativeTime("2026-03-15T12:00:00Z")).toBe("59m ago");
    vi.useRealTimers();
  });

  it("returns 1h at exactly 60 minutes ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T13:00:00Z"));
    expect(formatRelativeTime("2026-03-15T12:00:00Z")).toBe("1h ago");
    vi.useRealTimers();
  });

  it("returns 23h at 23 hours ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T11:00:00Z"));
    expect(formatRelativeTime("2026-03-15T12:00:00Z")).toBe("23h ago");
    vi.useRealTimers();
  });

  it("returns 1d at exactly 24 hours ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T12:00:00Z"));
    expect(formatRelativeTime("2026-03-15T12:00:00Z")).toBe("1d ago");
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
