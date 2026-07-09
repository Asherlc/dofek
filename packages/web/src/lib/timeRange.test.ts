import { describe, expect, it } from "vitest";
import {
  fixedRangeQueryInput,
  formatTimeRangeLabel,
  formatTimeRangeShortLabel,
  minimumSelectedRangeDays,
  selectedRangeQueryInput,
  TIME_RANGE_OPTIONS,
} from "./timeRange.ts";

describe("timeRange", () => {
  it("represents All as null in the shared selector options", () => {
    expect(TIME_RANGE_OPTIONS).toEqual([
      { label: "7d", days: 7 },
      { label: "14d", days: 14 },
      { label: "30d", days: 30 },
      { label: "90d", days: 90 },
      { label: "1y", days: 365 },
      { label: "All", days: null },
    ]);
  });

  it("builds selected-range query inputs without converting null to a sentinel", () => {
    expect(selectedRangeQueryInput(30)).toEqual({ days: 30 });
    expect(selectedRangeQueryInput(null)).toEqual({ days: null });
  });

  it("preserves All for selected ranges that have a finite minimum support window", () => {
    expect(minimumSelectedRangeDays(7, 90)).toBe(90);
    expect(minimumSelectedRangeDays(365, 90)).toBe(365);
    expect(minimumSelectedRangeDays(null, 90)).toBeNull();
  });

  it("marks intentional fixed range queries explicitly", () => {
    expect(fixedRangeQueryInput(365)).toEqual({ days: 365 });
  });

  it("formats All without rendering null days", () => {
    expect(formatTimeRangeLabel(null)).toBe("All");
    expect(formatTimeRangeShortLabel(null)).toBe("All");
    expect(formatTimeRangeLabel(30)).toBe("30 days");
    expect(formatTimeRangeShortLabel(30)).toBe("30d");
  });
});
