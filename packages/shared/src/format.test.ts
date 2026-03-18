import { describe, expect, it } from "vitest";
import {
  formatDateForDisplay,
  formatDateYmd,
  formatDurationMinutes,
  formatDurationRange,
  formatHour,
  formatRelativeTime,
  formatSleepDebt,
  formatSleepDebtInline,
  isToday,
} from "./format.ts";

describe("formatDateYmd", () => {
  it("formats a date as YYYY-MM-DD", () => {
    expect(formatDateYmd(new Date(2024, 0, 5))).toBe("2024-01-05");
  });

  it("pads month and day", () => {
    expect(formatDateYmd(new Date(2024, 2, 3))).toBe("2024-03-03");
  });
});

describe("formatDurationMinutes", () => {
  it("formats minutes only", () => {
    expect(formatDurationMinutes(45)).toBe("45m");
  });

  it("formats hours and minutes", () => {
    expect(formatDurationMinutes(90)).toBe("1h 30m");
  });

  it("handles zero minutes", () => {
    expect(formatDurationMinutes(60)).toBe("1h 0m");
  });
});

describe("formatDurationRange", () => {
  it("returns -- for null end", () => {
    expect(formatDurationRange("2024-01-01T10:00:00Z", null)).toBe("--");
  });

  it("formats duration between timestamps", () => {
    expect(
      formatDurationRange("2024-01-01T10:00:00Z", "2024-01-01T11:30:00Z"),
    ).toBe("1h 30m");
  });
});

describe("formatSleepDebt", () => {
  it("returns no debt for zero", () => {
    expect(formatSleepDebt(0)).toBe("No sleep debt");
  });

  it("returns no debt for negative", () => {
    expect(formatSleepDebt(-30)).toBe("No sleep debt");
  });

  it("formats positive debt", () => {
    expect(formatSleepDebt(90)).toBe("1h 30m debt");
  });
});

describe("formatHour", () => {
  it("formats midnight", () => {
    expect(formatHour(0)).toBe("12:00 AM");
  });

  it("formats noon", () => {
    expect(formatHour(12)).toBe("12:00 PM");
  });

  it("formats decimal hours", () => {
    expect(formatHour(22.5)).toBe("10:30 PM");
  });
});

describe("formatSleepDebtInline", () => {
  it("formats with 14-day context", () => {
    expect(formatSleepDebtInline(90)).toBe("1h 30m sleep debt (14 days)");
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
});

describe("formatDateForDisplay", () => {
  it("formats with weekday, month, day, year", () => {
    const result = formatDateForDisplay(new Date(2024, 0, 15));
    expect(result).toContain("Jan");
    expect(result).toContain("15");
    expect(result).toContain("2024");
  });
});

describe("formatRelativeTime", () => {
  it("returns just now for recent times", () => {
    expect(formatRelativeTime(new Date().toISOString())).toBe("just now");
  });

  it("returns minutes ago", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe("5m ago");
  });

  it("returns hours ago", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
    expect(formatRelativeTime(twoHoursAgo)).toBe("2h ago");
  });

  it("returns days ago", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    expect(formatRelativeTime(threeDaysAgo)).toBe("3d ago");
  });
});
