import { describe, expect, it } from "vitest";
import {
  acwrToScore,
  cardioPlan,
  clamp,
  computeTrainingStreak,
  daysAgoFromDate,
  getReadinessLevel,
  normalizeMuscleName,
  pickCardioFocus,
  pickStrengthSplit,
  uniqueStrings,
  zScoreToScore,
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

describe("zScoreToScore", () => {
  it("maps z=0 to 50", () => {
    expect(zScoreToScore(0)).toBe(50);
  });
  it("maps positive z-score above 50", () => {
    expect(zScoreToScore(1)).toBe(65);
  });
  it("maps negative z-score below 50", () => {
    expect(zScoreToScore(-1)).toBe(35);
  });
  it("clamps extreme positive", () => {
    expect(zScoreToScore(10)).toBe(100);
  });
  it("clamps extreme negative", () => {
    expect(zScoreToScore(-10)).toBe(0);
  });
});

describe("acwrToScore", () => {
  it("returns 50 for null", () => {
    expect(acwrToScore(null)).toBe(50);
  });
  it("returns 100 for perfect ACWR of 1.0", () => {
    expect(acwrToScore(1.0)).toBe(100);
  });
  it("penalizes deviation above 1", () => {
    expect(acwrToScore(1.5)).toBe(50);
  });
  it("penalizes deviation below 1", () => {
    expect(acwrToScore(0.5)).toBe(50);
  });
  it("clamps to 0 for extreme values", () => {
    expect(acwrToScore(3.0)).toBe(0);
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
});

describe("cardioPlan", () => {
  it("returns HIIT plan", () => {
    const plan = cardioPlan("hiit");
    expect(plan.title).toBe("Cardio HIIT Session");
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
    expect(plan.durationMinutes).toBe(50);
    expect(plan.targetZones).toEqual(["Z2"]);
    expect(plan.structure).toContain("Z2");
    expect(plan.details).toHaveLength(3);
    expect(plan.details[0]).toContain("steady");
    expect(plan.details[1]).toContain("hydrate");
    expect(plan.details[2]).toContain("cooldown");
  });
});
