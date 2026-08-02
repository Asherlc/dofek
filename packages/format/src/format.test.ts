import { describe, expect, it } from "vitest";
import {
  formatAssociationEstimateLabel,
  formatBodyCompositionNumber,
  formatBodyCompositionPercent,
  formatCalories,
  formatCaloriesMeasurement,
  formatClimbingAttemptResult,
  formatDateForDisplay,
  formatDateLong,
  formatDateMedium,
  formatDateShort,
  formatDateTime,
  formatDateYmd,
  formatDateYmdInTimeZone,
  formatDurationMinutes,
  formatDurationRange,
  formatDurationSeconds,
  formatGrams,
  formatHour,
  formatHRV,
  formatHRVMeasurement,
  formatIntensity,
  formatMonthYear,
  formatNumber,
  formatNutritionAmount,
  formatNutritionNumber,
  formatPace,
  formatPercent,
  formatReadinessDifference,
  formatRelativeTime,
  formatSigned,
  formatSleepDebt,
  formatSleepDebtInline,
  formatSpO2,
  formatSpO2Measurement,
  formatStandardDeviation,
  formatTableCellValue,
  formatTime,
  formatTimeOnly,
  formatTrainingLoad,
  formatWeekdayShort,
  formatWeekdayTime,
  isToday,
  isYesterday,
  parseValidDate,
  shiftDateYmd,
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

  it("shifts a date-only value by calendar days", () => {
    expect(shiftDateYmd("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDateYmd("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("rejects malformed dates, invalid calendar dates, and non-integer offsets", () => {
    expect(() => shiftDateYmd("not-a-date", 1)).toThrow(
      "Expected a valid YYYY-MM-DD date and an integer day offset",
    );
    expect(() => shiftDateYmd("2026-02-30", 1)).toThrow("Expected a valid YYYY-MM-DD date");
    expect(() => shiftDateYmd("2026-03-01", 0.5)).toThrow(
      "Expected a valid YYYY-MM-DD date and an integer day offset",
    );
  });
});

describe("date and time formatters", () => {
  it("formats short, medium, long, month, and weekday date labels", () => {
    const date = new Date(2026, 0, 5, 14, 30);

    expect(formatDateShort(date)).toBe("Jan 5");
    expect(formatDateMedium(date)).toBe("Jan 5, 2026");
    expect(formatDateLong(date)).toBe("Mon, Jan 5, 2026");
    expect(formatMonthYear(date)).toBe("January 2026");
    expect(formatWeekdayShort(date)).toBe("Mon");
  });

  it("formats date-only strings as local calendar days", () => {
    expect(formatDateMedium("2026-01-05")).toBe("Jan 5, 2026");
  });

  it("formats human date-time and time-only labels", () => {
    const date = new Date(2026, 0, 5, 14, 30);

    expect(formatDateTime(date)).toBe("Jan 5, 2026, 2:30 PM");
    expect(formatTimeOnly(date)).toBe("2:30 PM");
    expect(formatWeekdayTime(date)).toBe("Monday 2:30 PM");
  });

  it("supports timezone-aware date labels", () => {
    expect(formatDateLong("2026-01-01T05:00:00.000Z", { timeZone: "America/Los_Angeles" })).toBe(
      "Wed, Dec 31, 2025",
    );
    expect(formatDateYmdInTimeZone("2026-01-01T05:00:00.000Z", "America/Los_Angeles")).toBe(
      "2025-12-31",
    );
  });

  it("returns placeholders for invalid date labels", () => {
    expect(formatDateShort("not-a-date")).toBe("--");
    expect(formatDateTime("not-a-date")).toBe("--");
    expect(formatTimeOnly("not-a-date")).toBe("--");
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

  it("returns 0m for identical timestamps (kills < 0 → <= 0 mutant)", () => {
    expect(formatDurationRange("2024-01-01T10:00:00Z", "2024-01-01T10:00:00Z")).toBe("0m");
  });

  it("returns -- when end is before start (negative duration)", () => {
    expect(formatDurationRange("2024-01-01T11:00:00Z", "2024-01-01T10:00:00Z")).toBe("--");
  });
});

describe("formatDurationSeconds", () => {
  it("formats short durations as seconds", () => {
    expect(formatDurationSeconds(12)).toBe("12s");
    expect(formatDurationSeconds(1.24)).toBe("1.2s");
  });

  it("formats longer durations as minutes and hours", () => {
    expect(formatDurationSeconds(5410)).toBe("1h 30m");
  });

  it("returns placeholder for non-finite values", () => {
    expect(formatDurationSeconds(Number.NaN)).toBe("--");
  });
});

describe("formatClimbingAttemptResult", () => {
  it("formats sent and attempted climbs with singular and plural counts", () => {
    expect(formatClimbingAttemptResult(true, 1)).toBe("Sent in 1 attempt");
    expect(formatClimbingAttemptResult(true, 7)).toBe("Sent in 7 attempts");
    expect(formatClimbingAttemptResult(false, 1)).toBe("Attempted 1 time");
    expect(formatClimbingAttemptResult(false, 3)).toBe("Attempted 3 times");
  });
});

describe("formatReadinessDifference", () => {
  it("uses neutral direction labels for positive, negative, and zero differences", () => {
    expect(formatReadinessDifference(18.6)).toBe("18.6% higher");
    expect(formatReadinessDifference(-12.4)).toBe("12.4% lower");
    expect(formatReadinessDifference(0)).toBe("0.0% difference");
  });

  it("returns a placeholder for a non-finite difference", () => {
    expect(formatReadinessDifference(Number.NaN)).toBe("--");
  });
});

describe("formatAssociationEstimateLabel", () => {
  it("keeps the server-authored unavailable label intact", () => {
    expect(formatAssociationEstimateLabel("Estimate unavailable")).toBe("Estimate unavailable");
  });

  it("keeps a bare Estimate label from gaining a duplicate prefix", () => {
    expect(formatAssociationEstimateLabel("Estimate")).toBe("Estimate");
  });

  it("adds the estimate prefix to numeric server labels", () => {
    expect(formatAssociationEstimateLabel("18.6% higher")).toBe("Estimate: 18.6% higher");
  });

  it("normalizes surrounding whitespace without duplicating a server prefix", () => {
    expect(formatAssociationEstimateLabel("  Estimate unavailable  ")).toBe("Estimate unavailable");
    expect(formatAssociationEstimateLabel(" 18.6% higher ")).toBe("Estimate: 18.6% higher");
  });

  it("prefixes labels that mention Estimate away from the start", () => {
    expect(formatAssociationEstimateLabel("relative Estimate effect")).toBe(
      "Estimate: relative Estimate effect",
    );
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

  it("wraps 25 to 1:00 AM (kills % 24 removal)", () => {
    expect(formatHour(25, "en-US")).toBe("1:00 AM");
  });

  it("wraps 24 to 12:00 AM (midnight)", () => {
    expect(formatHour(24, "en-US")).toBe("12:00 AM");
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

describe("isYesterday", () => {
  it("returns true for yesterday", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(isYesterday(yesterday)).toBe(true);
  });

  it("returns false for today", () => {
    expect(isYesterday(new Date())).toBe(false);
  });

  it("returns false for two days ago", () => {
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    expect(isYesterday(twoDaysAgo)).toBe(false);
  });

  it("returns false for tomorrow", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(isYesterday(tomorrow)).toBe(false);
  });

  it("returns false for same day different year", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setFullYear(yesterday.getFullYear() - 1);
    expect(isYesterday(yesterday)).toBe(false);
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

  it("formats 0 pace", () => {
    expect(formatPace(0)).toBe("0:00");
  });

  it("formats exactly 60 seconds as 1:00", () => {
    expect(formatPace(60)).toBe("1:00");
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

  it("returns -- for empty string", () => {
    expect(formatTime("")).toBe("--");
  });

  it("handles postgres-style space-separated timestamps", () => {
    const result = formatTime("2024-03-15 14:30:00+00");
    expect(result).toContain("Mar");
    expect(result).toContain("15");
  });
});

describe("formatTableCellValue", () => {
  it("returns em dash for null and undefined", () => {
    expect(formatTableCellValue(null)).toBe("—");
    expect(formatTableCellValue(undefined)).toBe("—");
  });

  it("formats booleans and objects", () => {
    expect(formatTableCellValue(true)).toBe("Yes");
    expect(formatTableCellValue(false)).toBe("No");
    expect(formatTableCellValue({ foo: 1 })).toBe('{"foo":1}');
  });

  it("formats YYYY-MM-DD date strings", () => {
    expect(formatTableCellValue("2024-03-15")).toBe("Mar 15, 2024");
  });

  it("formats ISO and postgres timestamp strings", () => {
    const iso = formatTableCellValue("2024-03-15T10:30:00Z");
    expect(iso).not.toBe("2024-03-15T10:30:00Z");
    expect(iso).toContain("Mar");
    expect(iso).toContain("15");

    const postgres = formatTableCellValue("2024-03-15 10:30:00+00");
    expect(postgres).not.toBe("2024-03-15 10:30:00+00");
    expect(postgres).toContain("Mar");
  });

  it("returns plain strings and numbers unchanged", () => {
    expect(formatTableCellValue("hello")).toBe("hello");
    expect(formatTableCellValue(42)).toBe("42");
  });
});

describe("formatNumber", () => {
  it("formats with default 1 decimal", () => {
    expect(formatNumber(Math.PI)).toBe("3.1");
  });

  it("formats with 0 decimals", () => {
    expect(formatNumber(3.7, 0)).toBe("4");
  });

  it("formats with 2 decimals", () => {
    expect(formatNumber(1.456, 2)).toBe("1.46");
  });

  it("formats with 3 decimals", () => {
    expect(formatNumber(0.12345, 3)).toBe("0.123");
  });

  it("handles zero", () => {
    expect(formatNumber(0)).toBe("0.0");
  });

  it("handles negative numbers", () => {
    expect(formatNumber(-2.567, 1)).toBe("-2.6");
  });

  it("returns -- for NaN", () => {
    expect(formatNumber(Number.NaN)).toBe("--");
  });

  it("returns -- for Infinity", () => {
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("--");
  });

  it("returns -- for negative Infinity", () => {
    expect(formatNumber(Number.NEGATIVE_INFINITY)).toBe("--");
  });
});

describe("formatPercent", () => {
  it("formats a ratio as percentage with default 0 decimals", () => {
    expect(formatPercent(0.75)).toBe("75%");
  });

  it("formats with 1 decimal", () => {
    expect(formatPercent(0.756, 1)).toBe("75.6%");
  });

  it("handles 0", () => {
    expect(formatPercent(0)).toBe("0%");
  });

  it("handles 1 (100%)", () => {
    expect(formatPercent(1)).toBe("100%");
  });

  it("handles values already in percentage scale", () => {
    expect(formatPercent(75.6, 1)).toBe("7560.0%");
  });

  it("returns -- for NaN", () => {
    expect(formatPercent(Number.NaN)).toBe("--");
  });
});

describe("formatSigned", () => {
  it("prepends + for positive numbers", () => {
    expect(formatSigned(2.5, 1)).toBe("+2.5");
  });

  it("prepends - for negative numbers", () => {
    expect(formatSigned(-2.5, 1)).toBe("-2.5");
  });

  it("formats zero without sign", () => {
    expect(formatSigned(0, 1)).toBe("0.0");
  });

  it("formats zero with 0 decimals without + prefix (kills > 0 → >= 0 mutant)", () => {
    expect(formatSigned(0, 0)).toBe("0");
    expect(formatSigned(0, 0)).not.toMatch(/^\+/);
  });

  it("returns -- for NaN", () => {
    expect(formatSigned(Number.NaN)).toBe("--");
  });

  it("returns -- for Infinity", () => {
    expect(formatSigned(Number.POSITIVE_INFINITY)).toBe("--");
    expect(formatSigned(Number.NEGATIVE_INFINITY)).toBe("--");
  });

  it("prepends + for small positive values", () => {
    expect(formatSigned(0.1, 1)).toBe("+0.1");
    expect(formatSigned(0.1, 1)[0]).toBe("+");
  });
});

describe("domain metric formatters", () => {
  it("formats nutrition values with 0 decimals", () => {
    expect(formatNutritionNumber(12.4)).toBe("12");
    expect(formatNutritionNumber(12.5)).toBe("13");
    expect(formatCalories(1999.6)).toBe("2,000 kcal");
    expect(formatCaloriesMeasurement(1999.6)).toEqual({
      text: "2,000 kcal",
      parts: [
        { type: "integer", value: "2" },
        { type: "group", value: "," },
        { type: "integer", value: "000" },
        { type: "literal", value: " " },
        { type: "unit", value: "kcal" },
      ],
    });
    expect(formatGrams(41.5)).toBe("42 g");
    expect(formatNutritionAmount(680.4, "mg")).toBe("680 mg");
  });

  it("formats body composition values with 1 decimal", () => {
    expect(formatBodyCompositionNumber(82.44)).toBe("82.4");
    expect(formatBodyCompositionNumber(82.45)).toBe("82.5");
    expect(formatBodyCompositionPercent(18.24)).toBe("18.2%");
  });

  it("formats oxygen saturation with 0 decimals", () => {
    expect(formatSpO2(96.4)).toBe("96%");
    expect(formatSpO2(96.5)).toBe("97%");
    expect(formatSpO2Measurement(96.5)).toEqual({
      text: "97%",
      parts: [
        { type: "integer", value: "97" },
        { type: "unit", value: "%" },
      ],
    });
  });

  it("formats heart rate variability with 0 decimals", () => {
    expect(formatHRV(51.4)).toBe("51 ms");
    expect(formatHRV(51.5)).toBe("52 ms");
    expect(formatHRVMeasurement(51.5)).toEqual({
      text: "52 ms",
      parts: [
        { type: "integer", value: "52" },
        { type: "literal", value: " " },
        { type: "unit", value: "ms" },
      ],
    });
  });

  it("formats standard deviations with up to 2 decimals and no unit", () => {
    expect(formatStandardDeviation(-2)).toBe("-2");
    expect(formatStandardDeviation(-1.5)).toBe("-1.5");
    expect(formatStandardDeviation(-1.25)).toBe("-1.25");
    expect(formatStandardDeviation(1.91)).toBe("1.91");
  });

  it("formats intensity with 0 decimals", () => {
    expect(formatIntensity(82.4)).toBe("82%");
    expect(formatIntensity(82.5)).toBe("83%");
  });

  it("formats training load with 0 decimals", () => {
    expect(formatTrainingLoad(84.4)).toBe("84");
    expect(formatTrainingLoad(84.5)).toBe("85");
  });

  it("returns -- for absent or non-finite domain metric values", () => {
    expect(formatNutritionNumber(null)).toBe("--");
    expect(formatBodyCompositionNumber(undefined)).toBe("--");
    expect(formatSpO2(Number.NaN)).toBe("--");
    expect(formatSpO2Measurement(Number.NaN)).toEqual({
      text: "--",
      parts: [{ type: "nan", value: "--" }],
    });
    expect(formatHRV(Number.POSITIVE_INFINITY)).toBe("--");
    expect(formatStandardDeviation(null)).toBe("--");
    expect(formatStandardDeviation(Number.NaN)).toBe("--");
    expect(formatStandardDeviation(Number.POSITIVE_INFINITY)).toBe("--");
    expect(formatIntensity(Number.NEGATIVE_INFINITY)).toBe("--");
  });
});

describe("parseValidDate", () => {
  it("parses valid ISO 8601 strings", () => {
    const date = parseValidDate("2024-01-15T10:30:00Z");
    expect(date).toBeInstanceOf(Date);
    expect(date?.toISOString()).toBe("2024-01-15T10:30:00.000Z");
  });

  it("returns null for empty string", () => {
    expect(parseValidDate("")).toBeNull();
  });

  it("returns null for invalid string", () => {
    expect(parseValidDate("not-a-date")).toBeNull();
  });

  it("parses postgres-style space-separated timestamps", () => {
    const date = parseValidDate("2024-01-15 10:30:00+00");
    expect(date).toBeInstanceOf(Date);
  });

  it("handles postgres timestamps with microseconds", () => {
    const date = parseValidDate("2026-03-20 19:40:29.678162+00");
    expect(date).toBeInstanceOf(Date);
  });

  it("handles bare timezone offsets without colon", () => {
    const date = parseValidDate("2026-03-20 19:40:29+05");
    expect(date).toBeInstanceOf(Date);
  });
});
