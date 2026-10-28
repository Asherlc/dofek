import { describe, expect, it } from "vitest";
import {
  buildClimbingProgressionPeriods,
  climbingProgressionPeriodIndex,
} from "./climbing-grade-progression-periods.ts";

describe("buildClimbingProgressionPeriods", () => {
  it("returns no periods for no observations", () => {
    expect(buildClimbingProgressionPeriods([])).toEqual({
      firstMonth: 0,
      bucketMonths: 1,
      periods: [],
    });
  });

  it("covers whole calendar months, including leap days and missing months", () => {
    const calendar = buildClimbingProgressionPeriods([
      { date: "2024-03-20" },
      { date: "2024-01-31" },
    ]);
    expect(calendar).toEqual({
      firstMonth: 2024 * 12,
      bucketMonths: 1,
      periods: [
        { startDate: "2024-01-01", endDate: "2024-01-31" },
        { startDate: "2024-02-01", endDate: "2024-02-29" },
        { startDate: "2024-03-01", endDate: "2024-03-31" },
      ],
    });
    expect(
      climbingProgressionPeriodIndex("2024-02-29", calendar.firstMonth, calendar.bucketMonths),
    ).toBe(1);
  });

  it("uses at most six multi-month periods and clips the last period to the final month", () => {
    const calendar = buildClimbingProgressionPeriods([
      { date: "2025-01-31" },
      { date: "2026-04-03" },
    ]);
    expect(calendar.bucketMonths).toBe(3);
    expect(calendar.periods).toEqual([
      { startDate: "2025-01-01", endDate: "2025-03-31" },
      { startDate: "2025-04-01", endDate: "2025-06-30" },
      { startDate: "2025-07-01", endDate: "2025-09-30" },
      { startDate: "2025-10-01", endDate: "2025-12-31" },
      { startDate: "2026-01-01", endDate: "2026-03-31" },
      { startDate: "2026-04-01", endDate: "2026-04-30" },
    ]);
    expect(
      climbingProgressionPeriodIndex("2025-03-31", calendar.firstMonth, calendar.bucketMonths),
    ).toBe(0);
    expect(
      climbingProgressionPeriodIndex("2025-04-01", calendar.firstMonth, calendar.bucketMonths),
    ).toBe(1);
    expect(
      climbingProgressionPeriodIndex("2026-04-03", calendar.firstMonth, calendar.bucketMonths),
    ).toBe(5);
  });
});
