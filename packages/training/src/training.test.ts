import { describe, expect, it } from "vitest";
import {
  collapseWeeklyVolumeActivityTypes,
  formatActivityTypeLabel,
  OTHER_ACTIVITY_TYPE,
  selectRecentDailyLoad,
} from "./training";

describe("formatActivityTypeLabel", () => {
  it("maps known activity types to human-readable names", () => {
    expect(formatActivityTypeLabel("functional_strength")).toBe("Functional Strength");
    expect(formatActivityTypeLabel("strength_training")).toBe("Strength Training");
  });

  it("falls back to title-casing unknown snake_case activity types", () => {
    expect(formatActivityTypeLabel("mixed_cardio")).toBe("Mixed Cardio");
  });

  it("formats the grouped bucket label", () => {
    expect(formatActivityTypeLabel(OTHER_ACTIVITY_TYPE)).toBe("Other");
  });
});

describe("collapseWeeklyVolumeActivityTypes", () => {
  it("keeps the largest activity types and groups the rest as Other", () => {
    const rows = [
      { week: "2026-03-01", activity_type: "cycling", count: 1, hours: 8 },
      { week: "2026-03-01", activity_type: "running", count: 1, hours: 7 },
      { week: "2026-03-01", activity_type: "swimming", count: 1, hours: 6 },
      { week: "2026-03-01", activity_type: "walking", count: 1, hours: 5 },
      { week: "2026-03-01", activity_type: "yoga", count: 1, hours: 4 },
      { week: "2026-03-01", activity_type: "functional_strength", count: 1, hours: 3 },
      { week: "2026-03-01", activity_type: "hiking", count: 1, hours: 2 },
    ];

    const result = collapseWeeklyVolumeActivityTypes(rows, 6);
    const types = new Set(result.map((row) => row.activity_type));

    expect(types).toEqual(
      new Set(["cycling", "running", "swimming", "walking", "yoga", OTHER_ACTIVITY_TYPE]),
    );

    const otherRow = result.find((row) => row.activity_type === OTHER_ACTIVITY_TYPE);
    expect(otherRow?.hours).toBe(5);
    expect(otherRow?.count).toBe(2);
  });

  it("merges explicit other rows into the grouped Other bucket", () => {
    const rows = [
      { week: "2026-03-01", activity_type: "cycling", count: 1, hours: 10 },
      { week: "2026-03-01", activity_type: "running", count: 1, hours: 9 },
      { week: "2026-03-01", activity_type: "swimming", count: 1, hours: 8 },
      { week: "2026-03-01", activity_type: "walking", count: 1, hours: 7 },
      { week: "2026-03-01", activity_type: "other", count: 1, hours: 6 },
      { week: "2026-03-01", activity_type: "hiking", count: 1, hours: 5 },
      { week: "2026-03-01", activity_type: "yoga", count: 1, hours: 4 },
    ];

    const result = collapseWeeklyVolumeActivityTypes(rows, 6);
    const otherRows = result.filter((row) => row.activity_type === OTHER_ACTIVITY_TYPE);

    expect(otherRows).toHaveLength(1);
    expect(otherRows[0]?.hours).toBe(15);
    expect(otherRows[0]?.count).toBe(3);
  });
});

describe("selectRecentDailyLoad", () => {
  it("returns null when workload rows are empty", () => {
    expect(selectRecentDailyLoad([])).toBeNull();
  });

  it("returns the latest row when it has positive load", () => {
    const rows = [
      { date: "2026-03-15", dailyLoad: 42.1 },
      { date: "2026-03-16", dailyLoad: 55.3 },
    ];

    expect(selectRecentDailyLoad(rows)).toEqual(rows[1]);
  });

  it("falls back to the most recent non-zero row when latest day is zero", () => {
    const rows = [
      { date: "2026-03-14", dailyLoad: 31.2 },
      { date: "2026-03-15", dailyLoad: 0 },
      { date: "2026-03-16", dailyLoad: 0 },
    ];

    expect(selectRecentDailyLoad(rows)).toEqual(rows[0]);
  });

  it("returns the latest row when all rows are zero", () => {
    const rows = [
      { date: "2026-03-15", dailyLoad: 0 },
      { date: "2026-03-16", dailyLoad: 0 },
    ];

    expect(selectRecentDailyLoad(rows)).toEqual(rows[1]);
  });
});
