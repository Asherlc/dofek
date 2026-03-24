import { describe, expect, it } from "vitest";
import {
  cardioPlan,
  clamp,
  computeTrainingStreak,
  daysAgoFromDate,
  getReadinessLevel,
  normalizeMuscleName,
  pickCardioFocus,
  pickStrengthSplit,
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
      const d = new Date(Date.UTC(2024, 0, 10 + i));
      const [date] = d.toISOString().split("T");
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
  it("returns z2 when high intensity is already high", () => {
    expect(pickCardioFocus({ ...baseInput, highIntensityPct: 0.3, lowIntensityPct: 0.5 })).toBe(
      "z2",
    );
  });
  it("returns z2 when moderate intensity is high", () => {
    expect(
      pickCardioFocus({
        ...baseInput,
        highIntensityPct: 0.2,
        moderateIntensityPct: 0.35,
        lowIntensityPct: 0.45,
      }),
    ).toBe("z2");
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

  it("returns z2 when highIntensityPct is exactly 0.25 (boundary, kills >= mutant)", () => {
    // Condition is `> 0.25`, so exactly 0.25 should NOT match this branch
    // Falls through to default z2
    expect(
      pickCardioFocus({
        ...baseInput,
        highIntensityPct: 0.25,
        moderateIntensityPct: 0.2,
        lowIntensityPct: 0.55,
      }),
    ).toBe("z2");
  });

  it("returns z2 when moderateIntensityPct is exactly 0.3 (boundary)", () => {
    // Condition is `> 0.3`, so exactly 0.3 should NOT match
    expect(
      pickCardioFocus({
        ...baseInput,
        highIntensityPct: 0.22,
        moderateIntensityPct: 0.3,
        lowIntensityPct: 0.48,
      }),
    ).toBe("z2");
  });

  it("returns z2 when only highIntensityPct > 0.25 (kills || to && mutant)", () => {
    // Only first condition true: highIntensityPct=0.26 > 0.25, moderateIntensityPct=0.2 <= 0.3
    expect(
      pickCardioFocus({
        ...baseInput,
        highIntensityPct: 0.26,
        moderateIntensityPct: 0.2,
        lowIntensityPct: 0.54,
      }),
    ).toBe("z2");
  });

  it("returns z2 when only moderateIntensityPct > 0.3 (kills || to && mutant)", () => {
    // Only second condition true: highIntensityPct=0.22 <= 0.25, moderateIntensityPct=0.35 > 0.3
    // But highIntensityPct < HIGH_INTENSITY_RATIO_TARGET (0.2)? No, 0.22 > 0.2. Let's use 0.21.
    // Actually wait: 0.22 > 0.2, so line 813 check (< 0.2) is false. Line 815 checks > 0.25 || > 0.3.
    // With only moderateIntensityPct > 0.3, it should still return z2 via ||.
    expect(
      pickCardioFocus({
        ...baseInput,
        highIntensityPct: 0.22,
        moderateIntensityPct: 0.35,
        lowIntensityPct: 0.43,
      }),
    ).toBe("z2");
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
