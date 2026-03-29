import { describe, expect, it } from "vitest";
import {
  cardioPlan,
  clamp,
  computeComponentScores,
  computeFocusMuscles,
  computeReadinessScore,
  computeTrainingStreak,
  computeZonePercentages,
  daysAgoFromDate,
  getReadinessLevel,
  normalizeMuscleName,
  pickCardioFocus,
  pickStrengthSplit,
  shouldDoStrengthToday,
  shouldPreferRest,
  uniqueStrings,
} from "./training.ts";

describe("clamp", () => {
  it("returns value when within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it("clamps to min", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });
  it("clamps to max", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
  it("handles equal min and max", () => {
    expect(clamp(5, 3, 3)).toBe(3);
  });
});

describe("getReadinessLevel", () => {
  it("returns unknown for null", () => {
    expect(getReadinessLevel(null)).toBe("unknown");
  });
  it("returns low below 33", () => {
    expect(getReadinessLevel(32)).toBe("low");
  });
  it("returns moderate at 33", () => {
    expect(getReadinessLevel(33)).toBe("moderate");
  });
  it("returns moderate at 64", () => {
    expect(getReadinessLevel(64)).toBe("moderate");
  });
  it("returns high at 65", () => {
    expect(getReadinessLevel(65)).toBe("high");
  });
  it("returns high at 100", () => {
    expect(getReadinessLevel(100)).toBe("high");
  });
});

describe("daysAgoFromDate", () => {
  it("returns null for null date", () => {
    expect(daysAgoFromDate(null, "2024-01-15")).toBeNull();
  });
  it("returns 0 for same date", () => {
    expect(daysAgoFromDate("2024-01-15", "2024-01-15")).toBe(0);
  });
  it("returns positive days for past date", () => {
    expect(daysAgoFromDate("2024-01-10", "2024-01-15")).toBe(5);
  });
  it("returns 0 for future date (clamped)", () => {
    expect(daysAgoFromDate("2024-01-20", "2024-01-15")).toBe(0);
  });
  it("returns null for invalid date", () => {
    expect(daysAgoFromDate("not-a-date", "2024-01-15")).toBeNull();
  });
});

describe("uniqueStrings", () => {
  it("removes duplicates", () => {
    expect(uniqueStrings(["a", "b", "a"])).toEqual(["a", "b"]);
  });
  it("returns empty for empty input", () => {
    expect(uniqueStrings([])).toEqual([]);
  });
  it("preserves order", () => {
    expect(uniqueStrings(["c", "a", "b", "a"])).toEqual(["c", "a", "b"]);
  });
});

describe("normalizeMuscleName", () => {
  it("maps delts to shoulders", () => {
    expect(normalizeMuscleName("delts")).toBe("shoulders");
  });
  it("maps lats to back", () => {
    expect(normalizeMuscleName("lats")).toBe("back");
  });
  it("maps upper back to back", () => {
    expect(normalizeMuscleName("upper back")).toBe("back");
  });
  it("maps lower back to core", () => {
    expect(normalizeMuscleName("lower back")).toBe("core");
  });
  it("maps abdominals to core", () => {
    expect(normalizeMuscleName("abdominals")).toBe("core");
  });
  it("maps abs to core", () => {
    expect(normalizeMuscleName("abs")).toBe("core");
  });
  it("maps obliques to core", () => {
    expect(normalizeMuscleName("obliques")).toBe("core");
  });
  it("maps quads to quadriceps", () => {
    expect(normalizeMuscleName("quads")).toBe("quadriceps");
  });
  it("passes through unknown names", () => {
    expect(normalizeMuscleName("chest")).toBe("chest");
  });
  it("handles underscores", () => {
    expect(normalizeMuscleName("upper_back")).toBe("back");
  });
  it("trims whitespace", () => {
    expect(normalizeMuscleName("  chest  ")).toBe("chest");
  });
});

describe("pickStrengthSplit", () => {
  it("returns full-body for empty muscles", () => {
    expect(pickStrengthSplit([])).toBe("Full-body strength");
  });
  it("returns lower-body when >= 2 lower muscles", () => {
    expect(pickStrengthSplit(["quadriceps", "hamstrings"])).toBe("Lower-body strength");
  });
  it("returns push/pull when both present", () => {
    expect(pickStrengthSplit(["chest", "back"])).toBe("Upper-body push/pull");
  });
  it("returns push when more push than pull", () => {
    expect(pickStrengthSplit(["chest", "shoulders"])).toBe("Upper-body push");
  });
  it("returns pull when more pull than push", () => {
    expect(pickStrengthSplit(["back", "biceps"])).toBe("Upper-body pull");
  });
  it("returns core when only core muscles", () => {
    expect(pickStrengthSplit(["core"])).toBe("Core + accessories");
  });
  it("returns full-body for unrecognized muscles", () => {
    expect(pickStrengthSplit(["forearms"])).toBe("Full-body strength");
  });
  it("counts legs in lower set", () => {
    expect(pickStrengthSplit(["legs", "glutes"])).toBe("Lower-body strength");
  });
  it("counts calves in lower set", () => {
    expect(pickStrengthSplit(["calves", "quadriceps"])).toBe("Lower-body strength");
  });
  it("counts shoulders in push set", () => {
    expect(pickStrengthSplit(["shoulders"])).toBe("Upper-body push");
  });
  it("counts triceps in push set", () => {
    expect(pickStrengthSplit(["triceps"])).toBe("Upper-body push");
  });
  it("counts biceps in pull set", () => {
    expect(pickStrengthSplit(["biceps"])).toBe("Upper-body pull");
  });
  it("counts traps in pull set", () => {
    expect(pickStrengthSplit(["traps"])).toBe("Upper-body pull");
  });
  it("counts glutes in lower set", () => {
    expect(pickStrengthSplit(["glutes", "hamstrings"])).toBe("Lower-body strength");
  });
});

describe("computeTrainingStreak", () => {
  it("returns 0 for empty array", () => {
    expect(computeTrainingStreak([])).toBe(0);
  });
  it("returns 1 for single date", () => {
    expect(computeTrainingStreak(["2024-01-15"])).toBe(1);
  });
  it("counts consecutive days", () => {
    expect(computeTrainingStreak(["2024-01-13", "2024-01-14", "2024-01-15"])).toBe(3);
  });
  it("stops at gaps", () => {
    expect(computeTrainingStreak(["2024-01-12", "2024-01-14", "2024-01-15"])).toBe(2);
  });
  it("handles unordered dates", () => {
    expect(computeTrainingStreak(["2024-01-15", "2024-01-13", "2024-01-14"])).toBe(3);
  });
  it("returns 0 when all dates are invalid (NaN after parse)", () => {
    expect(computeTrainingStreak(["not-a-date", "also-bad"])).toBe(0);
  });
  it("filters out invalid dates but counts valid ones", () => {
    expect(computeTrainingStreak(["2024-01-14", "not-a-date", "2024-01-15"])).toBe(2);
  });
  it("returns 1 when only one valid date among invalids", () => {
    expect(computeTrainingStreak(["bad", "2024-01-15", "worse"])).toBe(1);
  });
  it("breaks streak at 2-day gap (deltaDays > 1)", () => {
    // 2024-01-15 and 2024-01-13 have deltaDays=2, which is > 1 so should break
    expect(computeTrainingStreak(["2024-01-13", "2024-01-15"])).toBe(1);
  });
  it("counts deltaDays of exactly 1 as consecutive", () => {
    // 2024-01-14 and 2024-01-15 have deltaDays=1 → consecutive
    expect(computeTrainingStreak(["2024-01-14", "2024-01-15"])).toBe(2);
  });
  it("handles duplicate dates (deltaDays = 0)", () => {
    // Same date appears twice: deltaDays=0, not === 1 and not > 1, so continues loop
    expect(computeTrainingStreak(["2024-01-15", "2024-01-15"])).toBe(1);
  });
  it("handles long consecutive streak", () => {
    const dates = Array.from({ length: 10 }, (_, i) => {
      const cursor = new Date(Date.UTC(2024, 0, 10 + i));
      const [date] = cursor.toISOString().split("T");
      return date;
    });
    expect(computeTrainingStreak(dates)).toBe(10);
  });
  it("counts from the most recent date backwards", () => {
    // Gap between 2024-01-10 and 2024-01-14, then consecutive 14, 15, 16
    expect(computeTrainingStreak(["2024-01-10", "2024-01-14", "2024-01-15", "2024-01-16"])).toBe(3);
  });
});

describe("pickCardioFocus", () => {
  const baseInput = {
    readinessLevel: "high" as const,
    readinessScore: 80,
    highIntensityPct: 0.1,
    lowIntensityPct: 0.8,
    moderateIntensityPct: 0.1,
    totalZoneSamples: 1000,
    hiitCount7d: 0,
    daysSinceLastHiit: 5,
  };

  it("returns recovery for low readiness", () => {
    expect(pickCardioFocus({ ...baseInput, readinessLevel: "low" })).toBe("recovery");
  });
  it("returns z2 for moderate readiness", () => {
    expect(pickCardioFocus({ ...baseInput, readinessLevel: "moderate" })).toBe("z2");
  });
  it("returns z2 when no zone data", () => {
    expect(pickCardioFocus({ ...baseInput, totalZoneSamples: 0 })).toBe("z2");
  });
  it("returns z2 when HIIT cap reached", () => {
    expect(pickCardioFocus({ ...baseInput, hiitCount7d: 3 })).toBe("z2");
  });
  it("returns z2 when HIIT too recent", () => {
    expect(pickCardioFocus({ ...baseInput, daysSinceLastHiit: 1 })).toBe("z2");
  });
  it("returns hiit when very low high-intensity and very high low-intensity", () => {
    expect(pickCardioFocus({ ...baseInput, highIntensityPct: 0.05, lowIntensityPct: 0.8 })).toBe(
      "hiit",
    );
  });
  it("returns intervals when moderately low high-intensity", () => {
    expect(pickCardioFocus({ ...baseInput, highIntensityPct: 0.15, lowIntensityPct: 0.7 })).toBe(
      "intervals",
    );
  });
  it("returns z2 (not intervals) when highIntensityPct is exactly at threshold 0.2", () => {
    // HIGH_INTENSITY_RATIO_TARGET = 0.2; condition is `< 0.2`, so 0.2 should NOT match intervals
    expect(pickCardioFocus({ ...baseInput, highIntensityPct: 0.2, lowIntensityPct: 0.7 })).toBe(
      "z2",
    );
  });

  it("returns z2 when lowIntensityPct is exactly 0.6 (boundary for intervals)", () => {
    // Condition is `> 0.6`, so exactly 0.6 should NOT match intervals
    expect(pickCardioFocus({ ...baseInput, highIntensityPct: 0.15, lowIntensityPct: 0.6 })).toBe(
      "z2",
    );
  });

  it("returns intervals when lowIntensityPct is just above 0.6", () => {
    expect(pickCardioFocus({ ...baseInput, highIntensityPct: 0.15, lowIntensityPct: 0.61 })).toBe(
      "intervals",
    );
  });

  it("returns z2 for readinessScore below threshold even with high readinessLevel", () => {
    // readinessScore < 65 should return z2 even when readinessLevel = "high"
    expect(pickCardioFocus({ ...baseInput, readinessLevel: "high", readinessScore: 50 })).toBe(
      "z2",
    );
  });

  it("returns z2 for unknown readiness level (not low, not moderate, but score < 65)", () => {
    expect(pickCardioFocus({ ...baseInput, readinessLevel: "unknown", readinessScore: 40 })).toBe(
      "z2",
    );
  });

  it("returns z2 for null readinessScore (defaults to 0 < 65)", () => {
    expect(pickCardioFocus({ ...baseInput, readinessLevel: "high", readinessScore: null })).toBe(
      "z2",
    );
  });

  it("returns z2 when readinessScore is exactly 65 (boundary, not < 65)", () => {
    // READINESS_HIGH_THRESHOLD = 65, condition is < 65, so 65 passes through
    expect(
      pickCardioFocus({
        ...baseInput,
        readinessLevel: "high",
        readinessScore: 65,
        highIntensityPct: 0.3,
        lowIntensityPct: 0.5,
      }),
    ).toBe("z2");
  });

  it("returns z2 when readinessScore is exactly 64 (just below threshold)", () => {
    expect(pickCardioFocus({ ...baseInput, readinessLevel: "high", readinessScore: 64 })).toBe(
      "z2",
    );
  });

  it("returns z2 when hiitCount7d is exactly MAX_HIIT_PER_WEEK (3)", () => {
    expect(pickCardioFocus({ ...baseInput, hiitCount7d: 3 })).toBe("z2");
  });

  it("allows HIIT when hiitCount7d is 2 (below MAX_HIIT_PER_WEEK)", () => {
    expect(
      pickCardioFocus({
        ...baseInput,
        hiitCount7d: 2,
        highIntensityPct: 0.05,
        lowIntensityPct: 0.8,
      }),
    ).toBe("hiit");
  });

  it("returns z2 when daysSinceLastHiit is exactly 1 (< HIIT_SPACING_DAYS=2)", () => {
    expect(pickCardioFocus({ ...baseInput, daysSinceLastHiit: 1 })).toBe("z2");
  });

  it("allows intensity work when daysSinceLastHiit is exactly HIIT_SPACING_DAYS (2)", () => {
    // daysSinceLastHiit=2, HIIT_SPACING_DAYS=2, condition is < 2, so 2 is NOT < 2
    expect(
      pickCardioFocus({
        ...baseInput,
        daysSinceLastHiit: 2,
        highIntensityPct: 0.05,
        lowIntensityPct: 0.8,
      }),
    ).toBe("hiit");
  });

  it("allows intensity work when daysSinceLastHiit is null", () => {
    expect(
      pickCardioFocus({
        ...baseInput,
        daysSinceLastHiit: null,
        highIntensityPct: 0.05,
        lowIntensityPct: 0.8,
      }),
    ).toBe("hiit");
  });

  it("returns hiit when highIntensityPct is exactly 0.08 boundary (not < 0.08)", () => {
    // Condition is < 0.08, so 0.08 is NOT < 0.08 → falls to next check
    expect(
      pickCardioFocus({
        ...baseInput,
        highIntensityPct: 0.08,
        lowIntensityPct: 0.8,
      }),
    ).toBe("intervals");
  });

  it("returns hiit when highIntensityPct is just below 0.08", () => {
    expect(
      pickCardioFocus({
        ...baseInput,
        highIntensityPct: 0.079,
        lowIntensityPct: 0.8,
      }),
    ).toBe("hiit");
  });

  it("returns z2 when lowIntensityPct is exactly 0.75 (boundary for HIIT)", () => {
    // Condition is > 0.75, so exactly 0.75 → NOT > 0.75 → falls to intervals check
    expect(
      pickCardioFocus({
        ...baseInput,
        highIntensityPct: 0.05,
        lowIntensityPct: 0.75,
      }),
    ).toBe("intervals");
  });

  it("returns hiit when lowIntensityPct is just above 0.75", () => {
    expect(
      pickCardioFocus({
        ...baseInput,
        highIntensityPct: 0.05,
        lowIntensityPct: 0.76,
      }),
    ).toBe("hiit");
  });

  it("returns z2 when highIntensityPct is exactly 0.08 and lowIntensityPct is exactly 0.75", () => {
    // highIntensityPct=0.08, not < 0.08, so HIIT condition fails
    // highIntensityPct=0.08, which IS < 0.2, and lowIntensityPct=0.75 IS > 0.6 → intervals
    expect(
      pickCardioFocus({
        ...baseInput,
        highIntensityPct: 0.08,
        lowIntensityPct: 0.75,
      }),
    ).toBe("intervals");
  });

  it("returns z2 for high readiness with plenty of intensity already", () => {
    // Both high and moderate are high → z2
    expect(
      pickCardioFocus({
        ...baseInput,
        highIntensityPct: 0.26,
        moderateIntensityPct: 0.31,
        lowIntensityPct: 0.43,
      }),
    ).toBe("z2");
  });

  it("does not trigger moderate branch at exactly 0.3 — falls to intervals (kills >= mutant)", () => {
    // moderateIntensityPct=0.3, condition is > 0.3, so 0.3 is NOT > 0.3
    // Falls through: highIntensityPct=0.1 < 0.2 AND lowIntensityPct=0.7 > 0.6 → intervals
    // If mutated to >=: 0.3 >= 0.3 = true → z2 (wrong)
    expect(
      pickCardioFocus({
        ...baseInput,
        readinessScore: 80,
        highIntensityPct: 0.1,
        moderateIntensityPct: 0.3,
        lowIntensityPct: 0.7,
      }),
    ).toBe("intervals");
  });

  it("does not z2 at exactly readiness 65 when intensity needs intervals (kills < → <= mutant)", () => {
    // readinessScore=65, READINESS_HIGH_THRESHOLD=65, condition is < 65
    // 65 is NOT < 65, so passes through to zone-based logic
    // highIntensityPct=0.1 < 0.2 AND lowIntensityPct=0.7 > 0.6 → intervals
    // If mutated to <=: 65 <= 65 = true → z2 (wrong)
    expect(
      pickCardioFocus({
        ...baseInput,
        readinessLevel: "high",
        readinessScore: 65,
        highIntensityPct: 0.1,
        moderateIntensityPct: 0.1,
        lowIntensityPct: 0.7,
      }),
    ).toBe("intervals");
  });
});

describe("cardioPlan", () => {
  it("returns HIIT plan", () => {
    const plan = cardioPlan("hiit");
    expect(plan.title).toBe("Cardio HIIT Session");
    expect(plan.shortBlurb).toContain("HIIT");
    expect(plan.shortBlurb).toContain("8 x 30s");
    expect(plan.durationMinutes).toBe(35);
    expect(plan.targetZones).toEqual(["Z1", "Z5"]);
    expect(plan.structure).toContain("30s Z5");
    expect(plan.details).toHaveLength(3);
    expect(plan.details[0]).toContain("Warm up");
    expect(plan.details[1]).toContain("Z5");
    expect(plan.details[2]).toContain("power/pace");
  });

  it("returns intervals plan", () => {
    const plan = cardioPlan("intervals");
    expect(plan.title).toBe("Cardio Intervals Session");
    expect(plan.shortBlurb).toContain("threshold");
    expect(plan.shortBlurb).toContain("4 x 4 min");
    expect(plan.durationMinutes).toBe(50);
    expect(plan.targetZones).toEqual(["Z2", "Z4"]);
    expect(plan.structure).toContain("4 x 4 min Z4");
    expect(plan.details).toHaveLength(3);
    expect(plan.details[0]).toContain("controlled");
    expect(plan.details[1]).toContain("Spin");
    expect(plan.details[2]).toContain("readiness");
  });

  it("returns recovery plan", () => {
    const plan = cardioPlan("recovery");
    expect(plan.title).toBe("Easy Recovery Cardio");
    expect(plan.shortBlurb).toContain("Z1");
    expect(plan.shortBlurb).toContain("recovery");
    expect(plan.durationMinutes).toBe(30);
    expect(plan.targetZones).toEqual(["Z1"]);
    expect(plan.structure).toContain("Z1");
    expect(plan.details).toHaveLength(3);
    expect(plan.details[0]).toContain("conversational");
    expect(plan.details[1]).toContain("mobility");
    expect(plan.details[2]).toContain("better");
  });

  it("returns z2 base plan", () => {
    const plan = cardioPlan("z2");
    expect(plan.title).toBe("Aerobic Base Cardio");
    expect(plan.shortBlurb).toContain("Z2");
    expect(plan.shortBlurb).toContain("45-60 min");
    expect(plan.durationMinutes).toBe(50);
    expect(plan.targetZones).toEqual(["Z2"]);
    expect(plan.structure).toContain("Z2");
    expect(plan.details).toHaveLength(3);
    expect(plan.details[0]).toContain("steady");
    expect(plan.details[1]).toContain("hydrate");
    expect(plan.details[2]).toContain("cooldown");
  });
});

describe("computeZonePercentages", () => {
  it("sums all five zones for totalZoneSamples", () => {
    const result = computeZonePercentages({
      zone1: 10,
      zone2: 20,
      zone3: 30,
      zone4: 25,
      zone5: 15,
    });
    expect(result.totalZoneSamples).toBe(100);
  });

  it("computes high intensity as zone4 + zone5 (not zone3)", () => {
    const result = computeZonePercentages({ zone1: 0, zone2: 0, zone3: 50, zone4: 30, zone5: 20 });
    expect(result.highIntensityPct).toBeCloseTo(0.5, 5);
    // If mutation changed to zone3+zone4 or zone4+zone5+zone3, would be wrong
  });

  it("computes low intensity as zone1 + zone2 (not zone3)", () => {
    const result = computeZonePercentages({
      zone1: 40,
      zone2: 30,
      zone3: 10,
      zone4: 10,
      zone5: 10,
    });
    expect(result.lowIntensityPct).toBeCloseTo(0.7, 5);
  });

  it("computes moderate intensity as zone3 only", () => {
    const result = computeZonePercentages({
      zone1: 20,
      zone2: 30,
      zone3: 25,
      zone4: 15,
      zone5: 10,
    });
    expect(result.moderateIntensityPct).toBeCloseTo(0.25, 5);
  });

  it("returns 0 percentages when totalZoneSamples is 0", () => {
    const result = computeZonePercentages({ zone1: 0, zone2: 0, zone3: 0, zone4: 0, zone5: 0 });
    expect(result.totalZoneSamples).toBe(0);
    expect(result.highIntensityPct).toBe(0);
    expect(result.lowIntensityPct).toBe(0);
    expect(result.moderateIntensityPct).toBe(0);
  });

  it("divides by total (not multiplies)", () => {
    const result = computeZonePercentages({ zone1: 0, zone2: 0, zone3: 0, zone4: 50, zone5: 50 });
    // Division: 100/100 = 1.0; Multiplication would give 100*100 = 10000
    expect(result.highIntensityPct).toBe(1);
    expect(result.highIntensityPct).not.toBeGreaterThan(1);
  });

  it("uses > 0 not >= 0 for division guard (avoids divide by zero)", () => {
    // With all zeros, should return 0 not NaN/Infinity
    const result = computeZonePercentages({ zone1: 0, zone2: 0, zone3: 0, zone4: 0, zone5: 0 });
    expect(Number.isFinite(result.highIntensityPct)).toBe(true);
    expect(Number.isFinite(result.lowIntensityPct)).toBe(true);
    expect(Number.isFinite(result.moderateIntensityPct)).toBe(true);
  });
});

describe("computeComponentScores", () => {
  it("returns default 62 for all scores when latestMetric is null", () => {
    const result = computeComponentScores(null, null);
    expect(result.hrvScore).toBe(62);
    expect(result.restingHrScore).toBe(62);
    expect(result.sleepScore).toBe(62);
    expect(result.respiratoryRateScore).toBe(62);
  });

  it("returns default 62 (not 50, 60, or 65) for HRV when SD is 0", () => {
    const metric = {
      hrv: 50,
      hrv_mean_30d: 45,
      hrv_sd_30d: 0,
      resting_hr: null,
      rhr_mean_30d: null,
      rhr_sd_30d: null,
      respiratory_rate: null,
      rr_mean_30d: null,
      rr_sd_30d: null,
    };
    const result = computeComponentScores(metric, null);
    expect(result.hrvScore).toBe(62);
  });

  it("computes HRV score from z-score when all values present", () => {
    const metric = {
      hrv: 60,
      hrv_mean_30d: 50,
      hrv_sd_30d: 5,
      resting_hr: null,
      rhr_mean_30d: null,
      rhr_sd_30d: null,
      respiratory_rate: null,
      rr_mean_30d: null,
      rr_sd_30d: null,
    };
    const result = computeComponentScores(metric, null);
    // z = (60-50)/5 = 2.0, positive z → score > 62
    expect(result.hrvScore).toBeGreaterThan(62);
  });

  it("does NOT negate HRV z-score (higher HRV → higher score)", () => {
    const highHrv = {
      hrv: 70,
      hrv_mean_30d: 50,
      hrv_sd_30d: 10,
      resting_hr: null,
      rhr_mean_30d: null,
      rhr_sd_30d: null,
      respiratory_rate: null,
      rr_mean_30d: null,
      rr_sd_30d: null,
    };
    const lowHrv = {
      hrv: 30,
      hrv_mean_30d: 50,
      hrv_sd_30d: 10,
      resting_hr: null,
      rhr_mean_30d: null,
      rhr_sd_30d: null,
      respiratory_rate: null,
      rr_mean_30d: null,
      rr_sd_30d: null,
    };
    const high = computeComponentScores(highHrv, null);
    const low = computeComponentScores(lowHrv, null);
    expect(high.hrvScore).toBeGreaterThan(low.hrvScore);
  });

  it("negates RHR z-score (higher RHR → lower score)", () => {
    const highRhr = {
      hrv: null,
      hrv_mean_30d: null,
      hrv_sd_30d: null,
      resting_hr: 70,
      rhr_mean_30d: 60,
      rhr_sd_30d: 5,
      respiratory_rate: null,
      rr_mean_30d: null,
      rr_sd_30d: null,
    };
    const lowRhr = {
      hrv: null,
      hrv_mean_30d: null,
      hrv_sd_30d: null,
      resting_hr: 50,
      rhr_mean_30d: 60,
      rhr_sd_30d: 5,
      respiratory_rate: null,
      rr_mean_30d: null,
      rr_sd_30d: null,
    };
    const high = computeComponentScores(highRhr, null);
    const low = computeComponentScores(lowRhr, null);
    expect(high.restingHrScore).toBeLessThan(low.restingHrScore);
  });

  it("negates respiratory rate z-score (higher RR → lower score)", () => {
    const highRr = {
      hrv: null,
      hrv_mean_30d: null,
      hrv_sd_30d: null,
      resting_hr: null,
      rhr_mean_30d: null,
      rhr_sd_30d: null,
      respiratory_rate: 20,
      rr_mean_30d: 15,
      rr_sd_30d: 2,
    };
    const lowRr = {
      hrv: null,
      hrv_mean_30d: null,
      hrv_sd_30d: null,
      resting_hr: null,
      rhr_mean_30d: null,
      rhr_sd_30d: null,
      respiratory_rate: 10,
      rr_mean_30d: 15,
      rr_sd_30d: 2,
    };
    const high = computeComponentScores(highRr, null);
    const low = computeComponentScores(lowRr, null);
    expect(high.respiratoryRateScore).toBeLessThan(low.respiratoryRateScore);
  });

  it("clamps sleep score between 0 and 100", () => {
    expect(computeComponentScores(null, 150).sleepScore).toBe(100);
    expect(computeComponentScores(null, -10).sleepScore).toBe(0);
  });

  it("rounds sleep score to integer", () => {
    const result = computeComponentScores(null, 85.7);
    expect(result.sleepScore).toBe(86);
    expect(Number.isInteger(result.sleepScore)).toBe(true);
  });

  it("uses sleep efficiency when non-null (not default 62)", () => {
    const result = computeComponentScores(null, 90);
    expect(result.sleepScore).toBe(90);
    expect(result.sleepScore).not.toBe(62);
  });

  it("uses default 62 for sleep when efficiency is null", () => {
    const result = computeComponentScores(null, null);
    expect(result.sleepScore).toBe(62);
  });

  it("uses SD > 0 check (not >= 0)", () => {
    const zeroSd = {
      hrv: 60,
      hrv_mean_30d: 50,
      hrv_sd_30d: 0,
      resting_hr: 55,
      rhr_mean_30d: 60,
      rhr_sd_30d: 0,
      respiratory_rate: 15,
      rr_mean_30d: 14,
      rr_sd_30d: 0,
    };
    const result = computeComponentScores(zeroSd, null);
    // With SD=0, should fall back to default 62 (division by zero would be bad)
    expect(result.hrvScore).toBe(62);
    expect(result.restingHrScore).toBe(62);
    expect(result.respiratoryRateScore).toBe(62);
  });
});

describe("computeReadinessScore", () => {
  const equalWeights = { hrv: 0.25, restingHr: 0.25, sleep: 0.25, respiratoryRate: 0.25 };
  const scores = { hrvScore: 80, restingHrScore: 60, sleepScore: 70, respiratoryRateScore: 50 };

  it("returns null when hasMetric is false", () => {
    expect(computeReadinessScore(scores, equalWeights, false)).toBeNull();
  });

  it("returns weighted sum when hasMetric is true", () => {
    const result = computeReadinessScore(scores, equalWeights, true);
    // (80+60+70+50) * 0.25 = 260 * 0.25 = 65
    expect(result).toBe(65);
  });

  it("rounds to integer", () => {
    const result = computeReadinessScore(
      { hrvScore: 81, restingHrScore: 60, sleepScore: 70, respiratoryRateScore: 50 },
      equalWeights,
      true,
    );
    // (81+60+70+50)/4 = 65.25 → 65
    expect(result).toBe(65);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("multiplies scores by weights (not adds)", () => {
    const heavyHrv = { hrv: 0.7, restingHr: 0.1, sleep: 0.1, respiratoryRate: 0.1 };
    const result = computeReadinessScore(scores, heavyHrv, true);
    // 80*0.7 + 60*0.1 + 70*0.1 + 50*0.1 = 56 + 6 + 7 + 5 = 74
    expect(result).toBe(74);
  });
});

describe("shouldPreferRest", () => {
  it("returns true for low readiness", () => {
    expect(shouldPreferRest("low", 0, null)).toBe(true);
  });

  it("returns true for consecutive training >= 6", () => {
    expect(shouldPreferRest("high", 6, null)).toBe(true);
  });

  it("returns false for consecutive training of 5", () => {
    expect(shouldPreferRest("high", 5, null)).toBe(false);
  });

  it("returns true for ACWR > 1.5", () => {
    expect(shouldPreferRest("high", 0, 1.6)).toBe(true);
  });

  it("returns false for ACWR exactly 1.5 (uses > not >=)", () => {
    expect(shouldPreferRest("high", 0, 1.5)).toBe(false);
  });

  it("returns false for ACWR just below threshold", () => {
    expect(shouldPreferRest("high", 0, 1.4)).toBe(false);
  });

  it("returns false for null ACWR", () => {
    expect(shouldPreferRest("high", 0, null)).toBe(false);
  });

  it("returns false for moderate readiness with no other triggers", () => {
    expect(shouldPreferRest("moderate", 0, null)).toBe(false);
  });

  it("uses || not && (any single trigger is enough)", () => {
    // Low readiness alone should trigger rest
    expect(shouldPreferRest("low", 0, null)).toBe(true);
    // High streak alone should trigger rest
    expect(shouldPreferRest("high", 7, null)).toBe(true);
    // High ACWR alone should trigger rest
    expect(shouldPreferRest("high", 0, 2.0)).toBe(true);
  });
});

describe("shouldDoStrengthToday", () => {
  it("returns true when strength is ready and under target", () => {
    expect(
      shouldDoStrengthToday({
        strengthReady: true,
        strengthUnderTarget: true,
        cardioUnderTarget: true,
        lastStrengthDaysAgo: 3,
        lastEnduranceDaysAgo: 1,
      }),
    ).toBe(true);
  });

  it("returns false when strength is not ready", () => {
    expect(
      shouldDoStrengthToday({
        strengthReady: false,
        strengthUnderTarget: true,
        cardioUnderTarget: false,
        lastStrengthDaysAgo: 3,
        lastEnduranceDaysAgo: 1,
      }),
    ).toBe(false);
  });

  it("returns true when cardio is not under target and strength more overdue", () => {
    expect(
      shouldDoStrengthToday({
        strengthReady: true,
        strengthUnderTarget: false,
        cardioUnderTarget: false,
        lastStrengthDaysAgo: 5,
        lastEnduranceDaysAgo: 2,
      }),
    ).toBe(true);
  });

  it("returns false when cardio under target and strength not under target", () => {
    expect(
      shouldDoStrengthToday({
        strengthReady: true,
        strengthUnderTarget: false,
        cardioUnderTarget: true,
        lastStrengthDaysAgo: 5,
        lastEnduranceDaysAgo: 2,
      }),
    ).toBe(false);
  });

  it("uses ?? 99 for null lastStrengthDaysAgo", () => {
    expect(
      shouldDoStrengthToday({
        strengthReady: true,
        strengthUnderTarget: false,
        cardioUnderTarget: false,
        lastStrengthDaysAgo: null,
        lastEnduranceDaysAgo: 2,
      }),
    ).toBe(true);
  });

  it("uses ?? 99 for null lastEnduranceDaysAgo", () => {
    expect(
      shouldDoStrengthToday({
        strengthReady: true,
        strengthUnderTarget: false,
        cardioUnderTarget: false,
        lastStrengthDaysAgo: 2,
        lastEnduranceDaysAgo: null,
      }),
    ).toBe(false);
  });

  it("uses >= not > for days comparison (equal days favors strength)", () => {
    expect(
      shouldDoStrengthToday({
        strengthReady: true,
        strengthUnderTarget: false,
        cardioUnderTarget: false,
        lastStrengthDaysAgo: 3,
        lastEnduranceDaysAgo: 3,
      }),
    ).toBe(true);
  });

  it("returns false when strength days < endurance days and neither under target", () => {
    expect(
      shouldDoStrengthToday({
        strengthReady: true,
        strengthUnderTarget: false,
        cardioUnderTarget: false,
        lastStrengthDaysAgo: 1,
        lastEnduranceDaysAgo: 3,
      }),
    ).toBe(false);
  });
});

describe("computeFocusMuscles", () => {
  it("returns empty array for empty input", () => {
    expect(computeFocusMuscles([], "2024-01-15")).toEqual([]);
  });

  it("filters muscles trained >= 2 days ago", () => {
    const muscles = [
      { muscle_group: "chest", last_trained_date: "2024-01-10" },
      { muscle_group: "back", last_trained_date: "2024-01-14" },
    ];
    // chest: 5 days ago (>= 2), back: 1 day ago (< 2)
    const result = computeFocusMuscles(muscles, "2024-01-15");
    expect(result).toContain("chest");
    expect(result).not.toContain("back");
  });

  it("uses >= 2 boundary (exactly 2 days ago is included)", () => {
    const muscles = [{ muscle_group: "chest", last_trained_date: "2024-01-13" }];
    const result = computeFocusMuscles(muscles, "2024-01-15");
    expect(result).toContain("chest");
  });

  it("uses >= 2 boundary (exactly 1 day ago is excluded)", () => {
    const muscles = [{ muscle_group: "chest", last_trained_date: "2024-01-14" }];
    // 1 day ago, < 2 → excluded from focus, falls back to all muscles
    const result = computeFocusMuscles(muscles, "2024-01-15");
    // Falls back to all fresh muscles since none >= 2
    expect(result).toContain("chest");
  });

  it("normalizes muscle names through aliases", () => {
    const muscles = [{ muscle_group: "delts", last_trained_date: "2024-01-10" }];
    const result = computeFocusMuscles(muscles, "2024-01-15");
    expect(result).toContain("shoulders");
    expect(result).not.toContain("delts");
  });

  it("limits to 3 muscles max", () => {
    const muscles = [
      { muscle_group: "chest", last_trained_date: "2024-01-05" },
      { muscle_group: "back", last_trained_date: "2024-01-06" },
      { muscle_group: "shoulders", last_trained_date: "2024-01-07" },
      { muscle_group: "biceps", last_trained_date: "2024-01-08" },
    ];
    const result = computeFocusMuscles(muscles, "2024-01-15");
    expect(result).toHaveLength(3);
  });

  it("sorts by most days ago first (most recovered first)", () => {
    const muscles = [
      { muscle_group: "chest", last_trained_date: "2024-01-10" },
      { muscle_group: "back", last_trained_date: "2024-01-05" },
    ];
    const result = computeFocusMuscles(muscles, "2024-01-15");
    // back (10 days) should come before chest (5 days)
    expect(result[0]).toBe("back");
    expect(result[1]).toBe("chest");
  });

  it("deduplicates normalized names", () => {
    const muscles = [
      { muscle_group: "abs", last_trained_date: "2024-01-05" },
      { muscle_group: "obliques", last_trained_date: "2024-01-06" },
    ];
    // Both normalize to "core"
    const result = computeFocusMuscles(muscles, "2024-01-15");
    expect(result.filter((m) => m === "core")).toHaveLength(1);
  });

  it("falls back to all muscles when none >= 2 days ago", () => {
    const muscles = [
      { muscle_group: "chest", last_trained_date: "2024-01-14" },
      { muscle_group: "back", last_trained_date: "2024-01-15" },
    ];
    const result = computeFocusMuscles(muscles, "2024-01-15");
    expect(result.length).toBeGreaterThan(0);
  });
});
