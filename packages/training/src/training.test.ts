import { describe, expect, it } from "vitest";
import {
  CANONICAL_ACTIVITY_TYPES,
  collapseWeeklyVolumeActivityTypes,
  createActivityTypeMapper,
  ENDURANCE_ACTIVITY_TYPES,
  formatActivityTypeLabel,
  OTHER_ACTIVITY_TYPE,
  selectRecentDailyLoad,
} from "./training";

// ============================================================
// Canonical activity types
// ============================================================

describe("CANONICAL_ACTIVITY_TYPES", () => {
  it("includes core endurance types", () => {
    expect(CANONICAL_ACTIVITY_TYPES).toContain("cycling");
    expect(CANONICAL_ACTIVITY_TYPES).toContain("running");
    expect(CANONICAL_ACTIVITY_TYPES).toContain("swimming");
    expect(CANONICAL_ACTIVITY_TYPES).toContain("walking");
    expect(CANONICAL_ACTIVITY_TYPES).toContain("hiking");
  });

  it("includes strength and fitness types", () => {
    expect(CANONICAL_ACTIVITY_TYPES).toContain("strength");
    expect(CANONICAL_ACTIVITY_TYPES).toContain("yoga");
    expect(CANONICAL_ACTIVITY_TYPES).toContain("pilates");
    expect(CANONICAL_ACTIVITY_TYPES).toContain("elliptical");
    expect(CANONICAL_ACTIVITY_TYPES).toContain("rowing");
  });

  it("includes 'other' as a catch-all", () => {
    expect(CANONICAL_ACTIVITY_TYPES).toContain("other");
  });

  it("has no duplicates", () => {
    const set = new Set(CANONICAL_ACTIVITY_TYPES);
    expect(set.size).toBe(CANONICAL_ACTIVITY_TYPES.length);
  });
});

// ============================================================
// ENDURANCE_ACTIVITY_TYPES
// ============================================================

describe("ENDURANCE_ACTIVITY_TYPES", () => {
  it("contains expected endurance activities", () => {
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("cycling");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("running");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("swimming");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("walking");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("hiking");
  });

  it("does not include non-endurance types", () => {
    const types: readonly string[] = ENDURANCE_ACTIVITY_TYPES;
    expect(types).not.toContain("strength");
    expect(types).not.toContain("yoga");
  });

  it("is a subset of CANONICAL_ACTIVITY_TYPES", () => {
    for (const t of ENDURANCE_ACTIVITY_TYPES) {
      expect(CANONICAL_ACTIVITY_TYPES).toContain(t);
    }
  });
});

// ============================================================
// createActivityTypeMapper
// ============================================================

describe("createActivityTypeMapper", () => {
  it("maps known types using the provided mapping", () => {
    const mapper = createActivityTypeMapper({ foo: "cycling", bar: "running" });
    expect(mapper("foo")).toBe("cycling");
    expect(mapper("bar")).toBe("running");
  });

  it("returns 'other' for unknown types", () => {
    const mapper = createActivityTypeMapper({ foo: "cycling" });
    expect(mapper("unknown_type")).toBe("other");
  });

  it("is case-sensitive (mapping keys are used as-is)", () => {
    const mapper = createActivityTypeMapper({ Ride: "cycling" });
    expect(mapper("Ride")).toBe("cycling");
    expect(mapper("ride")).toBe("other");
  });
});

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
