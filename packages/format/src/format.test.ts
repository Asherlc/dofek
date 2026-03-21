import { describe, expect, it } from "vitest";
import {
  formatDateForDisplay,
  formatDateYmd,
  formatDurationMinutes,
  formatDurationRange,
  formatHour,
  formatPace,
  formatRelativeTime,
  formatSleepDebt,
  formatSleepDebtInline,
  formatTime,
  isToday,
} from "./format.ts";

describe("formatDateYmd", () => {
  it("formats a date as YYYY-MM-DD", () => {
    expect(formatDateYmd(new Date(2024, 0, 5))).toBe("2024-01-05");
  });

  it("pads single-digit month and day", () => {
    expect(formatDateYmd(new Date(2024, 2, 3))).toBe("2024-03-03");
  });

  it("handles double-digit month and day", () => {
    expect(formatDateYmd(new Date(2024, 11, 25))).toBe("2024-12-25");
  });

  it("defaults to current date when no argument", () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(formatDateYmd()).toBe(expected);
  });
});

describe("formatDurationMinutes", () => {
  it("formats minutes only when < 60", () => {
    expect(formatDurationMinutes(45)).toBe("45m");
  });

  it("formats 0 minutes", () => {
    expect(formatDurationMinutes(0)).toBe("0m");
  });

  it("formats exactly 59 minutes without hours", () => {
    expect(formatDurationMinutes(59)).toBe("59m");
  });

  it("formats exactly 60 minutes as 1h 0m", () => {
    expect(formatDurationMinutes(60)).toBe("1h 0m");
  });

  it("formats hours and minutes", () => {
    expect(formatDurationMinutes(90)).toBe("1h 30m");
  });

  it("rounds fractional minutes", () => {
    expect(formatDurationMinutes(90.7)).toBe("1h 31m");
  });
});

describe("formatDurationRange", () => {
  it("returns -- for null end", () => {
    expect(formatDurationRange("2024-01-01T10:00:00Z", null)).toBe("--");
  });

  it("formats duration between timestamps", () => {
    expect(formatDurationRange("2024-01-01T10:00:00Z", "2024-01-01T11:30:00Z")).toBe("1h 30m");
  });

  it("formats short durations", () => {
    expect(formatDurationRange("2024-01-01T10:00:00Z", "2024-01-01T10:15:00Z")).toBe("15m");
  });

  it("returns -- when start timestamp is invalid", () => {
    expect(formatDurationRange("not-a-date", "2024-01-01T10:15:00Z")).toBe("--");
  });

  it("returns -- when end timestamp is invalid", () => {
    expect(formatDurationRange("2024-01-01T10:00:00Z", "not-a-date")).toBe("--");
  });

  it("handles postgres-style space-separated timestamps", () => {
    expect(formatDurationRange("2024-01-01 10:00:00+00", "2024-01-01 11:30:00+00")).toBe("1h 30m");
  });
});

describe("formatSleepDebt", () => {
  it("returns no debt for zero", () => {
    expect(formatSleepDebt(0)).toBe("No sleep debt");
  });

  it("returns no debt for negative", () => {
    expect(formatSleepDebt(-30)).toBe("No sleep debt");
  });

  it("formats positive debt in hours and minutes", () => {
    expect(formatSleepDebt(90)).toBe("1h 30m debt");
  });

  it("formats small debt", () => {
    expect(formatSleepDebt(15)).toBe("0h 15m debt");
  });

  it("returns no debt at exactly 0", () => {
    expect(formatSleepDebt(0)).toBe("No sleep debt");
  });

  it("formats debt at exactly 1 minute", () => {
    expect(formatSleepDebt(1)).toBe("0h 1m debt");
  });
});

describe("formatHour", () => {
  it("formats midnight (0) as 12:00 AM in en-US", () => {
    expect(formatHour(0, "en-US")).toBe("12:00 AM");
  });

  it("formats 1am in en-US", () => {
    expect(formatHour(1, "en-US")).toBe("1:00 AM");
  });

  it("formats 11am in en-US", () => {
    expect(formatHour(11, "en-US")).toBe("11:00 AM");
  });

  it("formats noon (12) as 12:00 PM in en-US", () => {
    expect(formatHour(12, "en-US")).toBe("12:00 PM");
  });

  it("formats 1pm in en-US", () => {
    expect(formatHour(13, "en-US")).toBe("1:00 PM");
  });

  it("formats decimal hours with minutes in en-US", () => {
    expect(formatHour(22.5, "en-US")).toBe("10:30 PM");
  });

  it("pads minutes to 2 digits in en-US", () => {
    expect(formatHour(9.083, "en-US")).toBe("9:05 AM");
  });

  it("uses 24-hour format for de-DE locale", () => {
    expect(formatHour(22.5, "de-DE")).toBe("22:30");
  });

  it("formats midnight in 24-hour locale", () => {
    expect(formatHour(0, "de-DE")).toBe("0:00");
  });

  it("uses device locale when no locale specified", () => {
    // Should not throw regardless of environment locale
    expect(() => formatHour(12)).not.toThrow();
  });
});

describe("formatSleepDebtInline", () => {
  it("formats with 14-day context", () => {
    expect(formatSleepDebtInline(90)).toBe("1h 30m sleep debt (14 days)");
  });

  it("formats zero minutes", () => {
    expect(formatSleepDebtInline(0)).toBe("0h 0m sleep debt (14 days)");
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

  it("returns false for tomorrow", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(isToday(tomorrow)).toBe(false);
  });

  it("returns false for same day different year", () => {
    const sameDay = new Date();
    sameDay.setFullYear(sameDay.getFullYear() - 1);
    expect(isToday(sameDay)).toBe(false);
  });

  it("returns false for same day different month", () => {
    const sameDay = new Date();
    sameDay.setMonth(sameDay.getMonth() - 1);
    expect(isToday(sameDay)).toBe(false);
  });
});

describe("formatDateForDisplay", () => {
  it("formats with weekday, month, day, year", () => {
    // Jan 15, 2024 is a Monday
    const result = formatDateForDisplay(new Date(2024, 0, 15));
    expect(result).toContain("Mon");
    expect(result).toContain("Jan");
    expect(result).toContain("15");
    expect(result).toContain("2024");
  });
});

describe("formatRelativeTime", () => {
  it("returns just now for recent times", () => {
    expect(formatRelativeTime(new Date().toISOString())).toBe("just now");
  });

  it("returns 1m ago at exactly 1 minute", () => {
    const oneMinAgo = new Date(Date.now() - 60000).toISOString();
    expect(formatRelativeTime(oneMinAgo)).toBe("1m ago");
  });

  it("returns minutes ago for < 60 minutes", () => {
    const ago = new Date(Date.now() - 59 * 60000).toISOString();
    expect(formatRelativeTime(ago)).toBe("59m ago");
  });

  it("returns 1h ago at exactly 60 minutes", () => {
    const ago = new Date(Date.now() - 60 * 60000).toISOString();
    expect(formatRelativeTime(ago)).toBe("1h ago");
  });

  it("returns hours ago for < 24 hours", () => {
    const ago = new Date(Date.now() - 23 * 3600000).toISOString();
    expect(formatRelativeTime(ago)).toBe("23h ago");
  });

  it("returns 1d ago at exactly 24 hours", () => {
    const ago = new Date(Date.now() - 24 * 3600000).toISOString();
    expect(formatRelativeTime(ago)).toBe("1d ago");
  });

  it("returns days ago for multi-day diffs", () => {
    const ago = new Date(Date.now() - 3 * 86400000).toISOString();
    expect(formatRelativeTime(ago)).toBe("3d ago");
  });

  it("handles Date objects (postgres-js on Linux/ARM returns Date for timestamps)", () => {
    const ago = new Date(Date.now() - 5 * 60000);
    expect(formatRelativeTime(ago)).toBe("5m ago");
  });

  it("handles postgres-style timestamp strings without T separator", () => {
    // postgres-js may return timestamps like "2024-01-15 10:30:00+00" (no T)
    // Hermes (React Native) and older Safari cannot parse this format
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60000);
    const pgFormat = fiveMinAgo.toISOString().replace("T", " ").replace("Z", "+00");
    expect(formatRelativeTime(pgFormat)).toBe("5m ago");
  });

  it("handles postgres-style timestamp strings with microseconds", () => {
    // Production postgres returns: "2026-03-20 19:40:29.678162+00"
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 3600000);
    const pgFormat = twoHoursAgo.toISOString().replace("T", " ").replace("Z", "162+00");
    expect(formatRelativeTime(pgFormat)).toBe("2h ago");
  });

  it("returns null for completely invalid input", () => {
    expect(formatRelativeTime("not-a-date")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(formatRelativeTime("")).toBeNull();
  });
});

describe("formatPace", () => {
  it("formats a standard pace", () => {
    expect(formatPace(300)).toBe("5:00");
  });

  it("formats pace with seconds", () => {
    expect(formatPace(330)).toBe("5:30");
  });

  it("pads single-digit seconds", () => {
    expect(formatPace(305)).toBe("5:05");
  });

  it("handles rollover when seconds round to 60", () => {
    // 299.7 -> Math.floor(299.7/60) = 4, Math.round(59.7) = 60 -> should be 5:00
    expect(formatPace(299.7)).toBe("5:00");
  });

  it("handles fractional seconds without rollover", () => {
    expect(formatPace(299.2)).toBe("4:59");
  });

  it("formats sub-minute pace", () => {
    expect(formatPace(45)).toBe("0:45");
  });
});

describe("formatTime", () => {
  it("formats an ISO string with month, day, and time", () => {
    const result = formatTime("2024-03-15T14:30:00Z");
    // The exact output depends on timezone, but should contain key parts
    expect(result).toContain("Mar");
    expect(result).toContain("15");
  });

  it("returns -- for invalid timestamps", () => {
    expect(formatTime("not-a-date")).toBe("--");
  });

  it("handles postgres-style space-separated timestamps", () => {
    const result = formatTime("2024-03-15 14:30:00+00");
    expect(result).toContain("Mar");
    expect(result).toContain("15");
  });
});
