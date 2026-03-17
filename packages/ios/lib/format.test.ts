import { describe, expect, it } from "vitest";
import {
  formatDurationMinutes,
  formatDurationRange,
  formatHour,
  formatSleepDebt,
  formatSleepDebtInline,
} from "./format";

describe("formatDurationMinutes", () => {
  it("formats minutes-only durations", () => {
    expect(formatDurationMinutes(45)).toBe("45m");
  });

  it("formats hours and minutes", () => {
    expect(formatDurationMinutes(90)).toBe("1h 30m");
  });

  it("formats zero minutes", () => {
    expect(formatDurationMinutes(0)).toBe("0m");
  });

  it("formats exact hours", () => {
    expect(formatDurationMinutes(120)).toBe("2h 0m");
  });
});

describe("formatDurationRange", () => {
  it("returns -- when end is null", () => {
    expect(formatDurationRange("2024-01-01T10:00:00Z", null)).toBe("--");
  });

  it("formats a 90-minute range", () => {
    expect(
      formatDurationRange(
        "2024-01-01T10:00:00Z",
        "2024-01-01T11:30:00Z",
      ),
    ).toBe("1h 30m");
  });

  it("formats a short range under an hour", () => {
    expect(
      formatDurationRange(
        "2024-01-01T10:00:00Z",
        "2024-01-01T10:25:00Z",
      ),
    ).toBe("25m");
  });
});

describe("formatSleepDebt", () => {
  it("returns no debt for zero", () => {
    expect(formatSleepDebt(0)).toBe("No sleep debt");
  });

  it("returns no debt for negative values", () => {
    expect(formatSleepDebt(-30)).toBe("No sleep debt");
  });

  it("formats debt in hours and minutes", () => {
    expect(formatSleepDebt(95)).toBe("1h 35m debt");
  });

  it("formats exact hour debt", () => {
    expect(formatSleepDebt(120)).toBe("2h 0m debt");
  });
});

describe("formatSleepDebtInline", () => {
  it("uses Math.floor not Math.round for hours", () => {
    // 89 minutes: Math.round(89/60)=1, Math.floor(89/60)=1 — same
    expect(formatSleepDebtInline(89)).toBe("1h 29m sleep debt (14 days)");
  });

  it("does not round up hours at boundary", () => {
    // 91 minutes: Math.round(91/60)=2 (bug), Math.floor(91/60)=1 (correct)
    expect(formatSleepDebtInline(91)).toBe("1h 31m sleep debt (14 days)");
  });

  it("handles exact hour values", () => {
    expect(formatSleepDebtInline(120)).toBe("2h 0m sleep debt (14 days)");
  });
});

describe("formatHour", () => {
  it("formats midnight as 12:00 AM", () => {
    expect(formatHour(0)).toBe("12:00 AM");
  });

  it("formats noon as 12:00 PM", () => {
    expect(formatHour(12)).toBe("12:00 PM");
  });

  it("formats 22.5 as 10:30 PM", () => {
    expect(formatHour(22.5)).toBe("10:30 PM");
  });

  it("formats 7.25 as 7:15 AM", () => {
    expect(formatHour(7.25)).toBe("7:15 AM");
  });

  it("does not produce :60 minutes for edge case", () => {
    // 22.999: the old code would produce Math.round(0.999*60)=60 → "10:60 PM"
    // Fixed: converts to total minutes first, then divides
    const result = formatHour(22.999);
    expect(result).not.toContain(":60");
    expect(result).toBe("11:00 PM");
  });

  it("handles 23.999 wrapping correctly", () => {
    const result = formatHour(23.999);
    expect(result).not.toContain(":60");
    expect(result).toBe("12:00 AM");
  });
});
