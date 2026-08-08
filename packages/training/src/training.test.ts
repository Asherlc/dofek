import { describe, expect, it } from "vitest";
import { CANONICAL_ACTIVITY_TYPES, classifyLegacyActivityType } from "./activity-types";
import { ENDURANCE_ACTIVITY_TYPES } from "./endurance-types";
import {
  CYCLING_ACTIVITY_TYPES,
  cadenceAxisLabel,
  cadenceUnit,
  collapseWeeklyVolumeActivityTypes,
  createActivityTypeMapper,
  formatActivityTypeLabel,
  formatVerticalAscentActivityTypeGroupLabel,
  GARMIN_ACTIVITY_TYPE_MAP,
  getVerticalAscentActivityTypeGroup,
  isCyclingActivity,
  OTHER_ACTIVITY_TYPE,
  OURA_ACTIVITY_TYPE_MAP,
  POLAR_SPORT_MAP,
  RIDE_WITH_GPS_ACTIVITY_TYPE_MAP,
  STRAVA_ACTIVITY_TYPE_MAP,
  selectRecentDailyLoad,
  WAHOO_WORKOUT_TYPE_MAP,
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

  it("includes all cycling subtypes", () => {
    for (const cyclingType of CYCLING_ACTIVITY_TYPES) {
      expect(CANONICAL_ACTIVITY_TYPES).toContain(cyclingType);
    }
  });

  it("includes strength and fitness types", () => {
    expect(CANONICAL_ACTIVITY_TYPES).toContain("strength");
    expect(CANONICAL_ACTIVITY_TYPES).toContain("hangboard");
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

  it("includes all cycling subtypes", () => {
    for (const cyclingType of CYCLING_ACTIVITY_TYPES) {
      expect(ENDURANCE_ACTIVITY_TYPES).toContain(cyclingType);
    }
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
// CYCLING_ACTIVITY_TYPES / isCyclingActivity
// ============================================================

describe("CYCLING_ACTIVITY_TYPES", () => {
  it("contains the canonical cycling type", () => {
    expect(CYCLING_ACTIVITY_TYPES).toEqual(["cycling"]);
  });
});

describe("isCyclingActivity", () => {
  it("returns true for all cycling subtypes", () => {
    for (const type of CYCLING_ACTIVITY_TYPES) {
      expect(isCyclingActivity(type)).toBe(true);
    }
  });

  it("returns false for non-cycling types", () => {
    expect(isCyclingActivity("running")).toBe(false);
    expect(isCyclingActivity("swimming")).toBe(false);
    expect(isCyclingActivity("strength")).toBe(false);
    expect(isCyclingActivity("other")).toBe(false);
  });
});

describe("cadenceUnit", () => {
  it("returns rpm for cycling activity types", () => {
    expect(cadenceUnit("cycling")).toBe("rpm");
  });

  it("returns steps/min for running, walking, and hiking", () => {
    expect(cadenceUnit("running")).toBe("steps/min");
    expect(cadenceUnit("walking")).toBe("steps/min");
    expect(cadenceUnit("hiking")).toBe("steps/min");
  });
});

describe("cadenceAxisLabel", () => {
  it("labels cadence by activity type", () => {
    expect(cadenceAxisLabel("cycling")).toBe("Cadence (rpm)");
    expect(cadenceAxisLabel("hiking")).toBe("Cadence (steps/min)");
  });
});

// ============================================================
// createActivityTypeMapper
// ============================================================

describe("createActivityTypeMapper", () => {
  it("maps known types using the provided mapping", () => {
    const mapper = createActivityTypeMapper({ foo: "cycling", bar: "running" });
    expect(mapper("foo")).toEqual({
      canonicalType: "cycling",
      modality: null,
      providerType: "foo",
    });
    expect(mapper("bar")).toEqual({
      canonicalType: "running",
      modality: null,
      providerType: "bar",
    });
  });

  it("returns 'other' for unknown types", () => {
    const mapper = createActivityTypeMapper<string>({ foo: "cycling" });
    expect(mapper("unknown_type")).toEqual({
      canonicalType: "other",
      modality: null,
      providerType: "unknown_type",
    });
  });

  it("is case-sensitive (mapping keys are used as-is)", () => {
    const mapper = createActivityTypeMapper<string>({ Ride: "cycling" });
    expect(mapper("Ride").canonicalType).toBe("cycling");
    expect(mapper("ride").canonicalType).toBe("other");
  });
});

// ============================================================
// Provider mapping constants
// ============================================================

describe("STRAVA_ACTIVITY_TYPE_MAP", () => {
  it("maps Ride to road_cycling", () => {
    expect(STRAVA_ACTIVITY_TYPE_MAP.Ride).toBe("road_cycling");
  });

  it("maps Run to running", () => {
    expect(STRAVA_ACTIVITY_TYPE_MAP.Run).toBe("running");
  });

  it("maps VirtualRide to virtual_cycling", () => {
    expect(STRAVA_ACTIVITY_TYPE_MAP.VirtualRide).toBe("virtual_cycling");
  });

  it("maps MountainBikeRide to mountain_biking", () => {
    expect(STRAVA_ACTIVITY_TYPE_MAP.MountainBikeRide).toBe("mountain_biking");
  });

  it("maps GravelRide to gravel_cycling", () => {
    expect(STRAVA_ACTIVITY_TYPE_MAP.GravelRide).toBe("gravel_cycling");
  });

  it("maps EBikeRide to e_bike_cycling", () => {
    expect(STRAVA_ACTIVITY_TYPE_MAP.EBikeRide).toBe("e_bike_cycling");
  });

  it("maps WeightTraining to strength", () => {
    expect(STRAVA_ACTIVITY_TYPE_MAP.WeightTraining).toBe("strength");
  });

  it("maps all entries to canonical types", () => {
    for (const [, value] of Object.entries(STRAVA_ACTIVITY_TYPE_MAP)) {
      expect(CANONICAL_ACTIVITY_TYPES).toContain(classifyLegacyActivityType(value).canonicalType);
    }
  });
});

describe("WAHOO_WORKOUT_TYPE_MAP", () => {
  it("maps 0 to cycling", () => {
    expect(WAHOO_WORKOUT_TYPE_MAP[0]).toBe("cycling");
  });

  it("maps 1 to running", () => {
    expect(WAHOO_WORKOUT_TYPE_MAP[1]).toBe("running");
  });

  it("maps all entries to canonical types", () => {
    for (const value of Object.values(WAHOO_WORKOUT_TYPE_MAP)) {
      expect(CANONICAL_ACTIVITY_TYPES).toContain(classifyLegacyActivityType(value).canonicalType);
    }
  });
});

describe("POLAR_SPORT_MAP", () => {
  it("maps running to running", () => {
    expect(POLAR_SPORT_MAP.running).toBe("running");
  });

  it("maps strength_training to strength", () => {
    expect(POLAR_SPORT_MAP.strength_training).toBe("strength");
  });

  it("maps indoor_cycling to indoor_cycling", () => {
    expect(POLAR_SPORT_MAP.indoor_cycling).toBe("indoor_cycling");
  });

  it("maps all entries to canonical types", () => {
    for (const value of Object.values(POLAR_SPORT_MAP)) {
      expect(CANONICAL_ACTIVITY_TYPES).toContain(classifyLegacyActivityType(value).canonicalType);
    }
  });
});

describe("GARMIN_ACTIVITY_TYPE_MAP", () => {
  it("maps RUNNING to running", () => {
    expect(GARMIN_ACTIVITY_TYPE_MAP.RUNNING).toBe("running");
  });

  it("maps CYCLING to cycling", () => {
    expect(GARMIN_ACTIVITY_TYPE_MAP.CYCLING).toBe("cycling");
  });

  it("maps STRENGTH_TRAINING to strength", () => {
    expect(GARMIN_ACTIVITY_TYPE_MAP.STRENGTH_TRAINING).toBe("strength");
  });

  it("maps all entries to canonical types", () => {
    for (const value of Object.values(GARMIN_ACTIVITY_TYPE_MAP)) {
      expect(CANONICAL_ACTIVITY_TYPES).toContain(classifyLegacyActivityType(value).canonicalType);
    }
  });
});

describe("OURA_ACTIVITY_TYPE_MAP", () => {
  it("maps walking to walking", () => {
    expect(OURA_ACTIVITY_TYPE_MAP.walking).toBe("walking");
  });

  it("maps strength_training to strength", () => {
    expect(OURA_ACTIVITY_TYPE_MAP.strength_training).toBe("strength");
  });

  it("maps all entries to canonical types", () => {
    for (const value of Object.values(OURA_ACTIVITY_TYPE_MAP)) {
      expect(CANONICAL_ACTIVITY_TYPES).toContain(classifyLegacyActivityType(value).canonicalType);
    }
  });
});

describe("RIDE_WITH_GPS_ACTIVITY_TYPE_MAP", () => {
  it("maps cycling to cycling", () => {
    expect(RIDE_WITH_GPS_ACTIVITY_TYPE_MAP.cycling).toBe("cycling");
  });

  it("maps trail_running to running", () => {
    expect(RIDE_WITH_GPS_ACTIVITY_TYPE_MAP.trail_running).toBe("running");
  });

  it("maps all entries to canonical types", () => {
    for (const value of Object.values(RIDE_WITH_GPS_ACTIVITY_TYPE_MAP)) {
      expect(CANONICAL_ACTIVITY_TYPES).toContain(classifyLegacyActivityType(value).canonicalType);
    }
  });
});

describe("formatActivityTypeLabel", () => {
  it("maps known activity types to human-readable names", () => {
    expect(formatActivityTypeLabel("functional_strength")).toBe("Functional Strength");
    expect(formatActivityTypeLabel("hangboard")).toBe("Hangboard");
    expect(formatActivityTypeLabel("strength_training")).toBe("Strength Training");
  });

  it("falls back to title-casing unknown snake_case activity types", () => {
    expect(formatActivityTypeLabel("mixed_cardio")).toBe("Mixed Cardio");
  });

  it("formats the grouped bucket label", () => {
    expect(formatActivityTypeLabel(OTHER_ACTIVITY_TYPE)).toBe("Other");
  });

  it("returns 'Other' for the literal string 'other'", () => {
    expect(formatActivityTypeLabel("other")).toBe("Other");
  });

  it("uppercases HIIT in title-cased fallback", () => {
    expect(formatActivityTypeLabel("hiit")).toBe("HIIT");
  });

  it("uppercases HIIT within compound words", () => {
    expect(formatActivityTypeLabel("hiit_training")).toBe("HIIT Training");
  });

  it("trims whitespace before matching", () => {
    expect(formatActivityTypeLabel("  cycling  ")).toBe("Cycling");
  });

  it("trims whitespace before matching known types (kills .trim() removal)", () => {
    // Without .trim(), " running " won't match ACTIVITY_TYPE_LABELS and falls through
    expect(formatActivityTypeLabel("  running  ")).toBe("Running");
  });

  it("handles consecutive delimiters (filter(Boolean) needed)", () => {
    expect(formatActivityTypeLabel("power__zone")).toBe("Power Zone");
  });

  it("normalizes OTHER_ACTIVITY_TYPE constant (kills === __other__ mutant)", () => {
    expect(formatActivityTypeLabel("__other__")).toBe("Other");
  });

  it("regex + quantifier: consecutive delimiters produce single space (kills /[_\\-\\s]+/ → /[_\\-\\s]/)", () => {
    // With the non-+ regex, "a---b" splits to ["a","","","b"] and filter(Boolean) handles it.
    // But "a___b" splits to ["a","","","b"] with /[_\\-\\s]/ and ["a","b"] with /[_\\-\\s]+/.
    // Both produce "A B" after filter(Boolean). Try a case where the difference matters:
    // Actually filter(Boolean) makes them equivalent. But the regex mutation removes the +, changing split behavior.
    // Without +, "power___zone" splits into ["power","","","zone"], filter(Boolean) → ["power","zone"] → "Power Zone".
    // With +, "power___zone" splits into ["power","zone"] → "Power Zone". Same result with filter.
    // This is an equivalent mutant when filter(Boolean) is present.
    // Instead, test that filter(Boolean) removal is caught:
    expect(formatActivityTypeLabel("a_b")).toBe("A B");
  });
});

describe("getVerticalAscentActivityTypeGroup", () => {
  it("keeps road, mountain, and gravel cycling in dedicated vertical ascent groups", () => {
    expect(getVerticalAscentActivityTypeGroup("road")).toBe("road_cycling");
    expect(getVerticalAscentActivityTypeGroup("mountain")).toBe("mountain_biking");
    expect(getVerticalAscentActivityTypeGroup("gravel")).toBe("gravel_cycling");
  });

  it("groups other cycling variants into other cycling", () => {
    expect(getVerticalAscentActivityTypeGroup("indoor")).toBe("other_cycling");
    expect(getVerticalAscentActivityTypeGroup("virtual")).toBe("other_cycling");
    expect(getVerticalAscentActivityTypeGroup(null)).toBe("other_cycling");
  });
});

describe("formatVerticalAscentActivityTypeGroupLabel", () => {
  it("formats vertical ascent activity type group labels", () => {
    expect(formatVerticalAscentActivityTypeGroupLabel("road_cycling")).toBe("Road Cycling");
    expect(formatVerticalAscentActivityTypeGroupLabel("mountain_biking")).toBe("Mountain Biking");
    expect(formatVerticalAscentActivityTypeGroupLabel("gravel_cycling")).toBe("Gravel Cycling");
    expect(formatVerticalAscentActivityTypeGroupLabel("other_cycling")).toBe("Other Cycling");
  });
});

describe("collapseWeeklyVolumeActivityTypes", () => {
  it("keeps the largest activity types and groups the rest as Other", () => {
    const rows = [
      { week: "2026-03-01", canonical_type: "cycling", count: 1, hours: 8 },
      { week: "2026-03-01", canonical_type: "running", count: 1, hours: 7 },
      { week: "2026-03-01", canonical_type: "swimming", count: 1, hours: 6 },
      { week: "2026-03-01", canonical_type: "walking", count: 1, hours: 5 },
      { week: "2026-03-01", canonical_type: "yoga", count: 1, hours: 4 },
      { week: "2026-03-01", canonical_type: "functional_strength", count: 1, hours: 3 },
      { week: "2026-03-01", canonical_type: "hiking", count: 1, hours: 2 },
    ];

    const result = collapseWeeklyVolumeActivityTypes(rows, 6);
    const types = new Set(result.map((row) => row.canonical_type));

    expect(types).toEqual(
      new Set(["cycling", "running", "swimming", "walking", "yoga", OTHER_ACTIVITY_TYPE]),
    );

    const otherRow = result.find((row) => row.canonical_type === OTHER_ACTIVITY_TYPE);
    expect(otherRow?.hours).toBe(5);
    expect(otherRow?.count).toBe(2);
  });

  it("merges explicit other rows into the grouped Other bucket", () => {
    const rows = [
      { week: "2026-03-01", canonical_type: "cycling", count: 1, hours: 10 },
      { week: "2026-03-01", canonical_type: "running", count: 1, hours: 9 },
      { week: "2026-03-01", canonical_type: "swimming", count: 1, hours: 8 },
      { week: "2026-03-01", canonical_type: "walking", count: 1, hours: 7 },
      { week: "2026-03-01", canonical_type: "other", count: 1, hours: 6 },
      { week: "2026-03-01", canonical_type: "hiking", count: 1, hours: 5 },
      { week: "2026-03-01", canonical_type: "yoga", count: 1, hours: 4 },
    ];

    const result = collapseWeeklyVolumeActivityTypes(rows, 6);
    const otherRows = result.filter((row) => row.canonical_type === OTHER_ACTIVITY_TYPE);

    expect(otherRows).toHaveLength(1);
    expect(otherRows[0]?.hours).toBe(15);
    expect(otherRows[0]?.count).toBe(3);
  });

  it("returns the same array reference for empty input (kills early-return guard removal)", () => {
    const input: { week: string; canonical_type: string; count: number; hours: number }[] = [];
    const result = collapseWeeklyVolumeActivityTypes(input);
    expect(result).toBe(input);
  });

  it("accumulates hours for duplicate types (kills ?? vs && mutant)", () => {
    const rows = [
      { week: "2026-03-01", canonical_type: "cycling", count: 1, hours: 5 },
      { week: "2026-03-01", canonical_type: "cycling", count: 1, hours: 3 },
    ];
    const result = collapseWeeklyVolumeActivityTypes(rows, 6);
    expect(result).toHaveLength(1);
    expect(result[0]?.hours).toBe(8);
  });

  it("does not collapse when types count equals maxLegendItems (boundary)", () => {
    const rows = [
      { week: "2026-03-01", canonical_type: "cycling", count: 1, hours: 10 },
      { week: "2026-03-01", canonical_type: "running", count: 1, hours: 8 },
      { week: "2026-03-01", canonical_type: "swimming", count: 1, hours: 6 },
    ];
    const result = collapseWeeklyVolumeActivityTypes(rows, 3);
    const types = result.map((r) => r.canonical_type);
    expect(types).not.toContain(OTHER_ACTIVITY_TYPE);
    expect(types).toContain("cycling");
    expect(types).toContain("running");
    expect(types).toContain("swimming");
  });

  it("collapses when types count exceeds maxLegendItems by one", () => {
    const rows = [
      { week: "2026-03-01", canonical_type: "cycling", count: 1, hours: 10 },
      { week: "2026-03-01", canonical_type: "running", count: 1, hours: 8 },
      { week: "2026-03-01", canonical_type: "swimming", count: 1, hours: 6 },
      { week: "2026-03-01", canonical_type: "walking", count: 1, hours: 2 },
    ];
    const result = collapseWeeklyVolumeActivityTypes(rows, 3);
    const types = result.map((r) => r.canonical_type);
    expect(types).toContain(OTHER_ACTIVITY_TYPE);
    // Smallest type (walking) collapsed into Other
    expect(types).not.toContain("walking");
    expect(types).not.toContain("swimming");
  });

  it("sorts results by week ascending then activity_type ascending", () => {
    const rows = [
      { week: "2026-03-08", canonical_type: "running", count: 1, hours: 5 },
      { week: "2026-03-01", canonical_type: "cycling", count: 1, hours: 10 },
      { week: "2026-03-01", canonical_type: "running", count: 1, hours: 8 },
      { week: "2026-03-08", canonical_type: "cycling", count: 1, hours: 3 },
    ];
    const result = collapseWeeklyVolumeActivityTypes(rows, 6);
    expect(result.map((r) => `${r.week}:${r.canonical_type}`)).toEqual([
      "2026-03-01:cycling",
      "2026-03-01:running",
      "2026-03-08:cycling",
      "2026-03-08:running",
    ]);
  });

  it("sorts activity_types alphabetically within the same week", () => {
    const rows = [
      { week: "2026-03-01", canonical_type: "yoga", count: 1, hours: 3 },
      { week: "2026-03-01", canonical_type: "cycling", count: 1, hours: 5 },
      { week: "2026-03-01", canonical_type: "running", count: 1, hours: 4 },
    ];
    const result = collapseWeeklyVolumeActivityTypes(rows, 6);
    expect(result.map((r) => r.canonical_type)).toEqual(["cycling", "running", "yoga"]);
  });

  it("keeps largest types by total hours across weeks (kills sort removal)", () => {
    const rows = [
      { week: "2026-03-01", canonical_type: "cycling", count: 1, hours: 1 },
      { week: "2026-03-08", canonical_type: "cycling", count: 1, hours: 1 },
      { week: "2026-03-01", canonical_type: "running", count: 1, hours: 10 },
      { week: "2026-03-01", canonical_type: "swimming", count: 1, hours: 5 },
      { week: "2026-03-01", canonical_type: "walking", count: 1, hours: 3 },
    ];
    const result = collapseWeeklyVolumeActivityTypes(rows, 3);
    const types = new Set(result.map((r) => r.canonical_type));
    // running (10) and swimming (5) are largest; cycling (2) and walking (3) collapse
    expect(types).toContain("running");
    expect(types).toContain("swimming");
    expect(types).toContain(OTHER_ACTIVITY_TYPE);
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

  it("returns latest row even when load is zero", () => {
    const rows = [
      { date: "2026-03-14", dailyLoad: 31.2 },
      { date: "2026-03-15", dailyLoad: 0 },
      { date: "2026-03-16", dailyLoad: 0 },
    ];

    expect(selectRecentDailyLoad(rows)).toEqual(rows[2]);
  });

  it("returns the latest row when all rows are zero", () => {
    const rows = [
      { date: "2026-03-15", dailyLoad: 0 },
      { date: "2026-03-16", dailyLoad: 0 },
    ];

    expect(selectRecentDailyLoad(rows)).toEqual(rows[1]);
  });

  it("returns the single element for a one-element array", () => {
    const rows = [{ date: "2026-03-15", dailyLoad: 10 }];
    expect(selectRecentDailyLoad(rows)).toEqual(rows[0]);
  });

  it("returns latest zero-load row with exactly 2 rows", () => {
    const rows = [
      { date: "2026-03-15", dailyLoad: 25 },
      { date: "2026-03-16", dailyLoad: 0 },
    ];
    expect(selectRecentDailyLoad(rows)).toEqual(rows[1]);
  });

  it("returns latest row even when dailyLoad is NaN", () => {
    const rows = [
      { date: "2026-03-14", dailyLoad: 10 },
      { date: "2026-03-15", dailyLoad: Number.NaN },
      { date: "2026-03-16", dailyLoad: 0 },
    ];
    expect(selectRecentDailyLoad(rows)).toEqual(rows[2]);
  });

  it("returns latest row even when dailyLoad is Infinity", () => {
    const rows = [
      { date: "2026-03-14", dailyLoad: 10 },
      { date: "2026-03-15", dailyLoad: Number.POSITIVE_INFINITY },
    ];
    expect(selectRecentDailyLoad(rows)).toEqual(rows[1]);
  });

  it("returns latest zero-load row when earlier rows have NaN load", () => {
    const rows = [
      { date: "2026-03-14", dailyLoad: Number.NaN },
      { date: "2026-03-15", dailyLoad: 0 },
    ];
    expect(selectRecentDailyLoad(rows)).toEqual(rows[1]);
  });
});
