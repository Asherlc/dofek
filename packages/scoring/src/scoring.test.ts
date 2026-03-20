import { describe, expect, it } from "vitest";
import { statusColors, textColors } from "./colors.ts";
import {
  aggregateWeeklyVolume,
  FORM_ZONE_COLORS,
  FORM_ZONE_FRESH,
  FORM_ZONE_GREY,
  FORM_ZONE_OPTIMAL,
  FORM_ZONE_TRANSITION,
  formZoneColor,
  formZoneLabel,
  rampRateColor,
  scoreColor,
  scoreLabel,
  sleepDebtColor,
  stressColor,
  stressLabel,
  trendColor,
  trendDirection,
  workloadRatioColor,
  workloadRatioHint,
} from "./scoring.ts";

describe("scoreColor", () => {
  it("returns positive for scores > 70", () => {
    expect(scoreColor(71)).toBe(statusColors.positive);
    expect(scoreColor(100)).toBe(statusColors.positive);
  });

  it("returns warning at exactly 70 (boundary)", () => {
    expect(scoreColor(70)).toBe(statusColors.warning);
  });

  it("returns warning at exactly 50 (boundary)", () => {
    expect(scoreColor(50)).toBe(statusColors.warning);
  });

  it("returns danger at exactly 49 (boundary)", () => {
    expect(scoreColor(49)).toBe(statusColors.danger);
  });

  it("returns danger for scores < 50", () => {
    expect(scoreColor(0)).toBe(statusColors.danger);
  });
});

describe("scoreLabel", () => {
  it("returns Recovered for scores > 70", () => {
    expect(scoreLabel(71)).toBe("Recovered");
  });

  it("returns Moderate at exactly 70 (boundary)", () => {
    expect(scoreLabel(70)).toBe("Moderate");
  });

  it("returns Moderate at exactly 50 (boundary)", () => {
    expect(scoreLabel(50)).toBe("Moderate");
  });

  it("returns Poor at exactly 49 (boundary)", () => {
    expect(scoreLabel(49)).toBe("Poor");
  });

  it("returns Poor for low scores", () => {
    expect(scoreLabel(0)).toBe("Poor");
  });
});

describe("workloadRatioColor", () => {
  it("returns secondary color for null", () => {
    expect(workloadRatioColor(null)).toBe(textColors.secondary);
  });

  it("returns positive at exact boundaries 0.8 and 1.3", () => {
    expect(workloadRatioColor(0.8)).toBe(statusColors.positive);
    expect(workloadRatioColor(1.3)).toBe(statusColors.positive);
  });

  it("returns positive in the middle of optimal range", () => {
    expect(workloadRatioColor(1.0)).toBe(statusColors.positive);
  });

  it("returns warning just outside optimal range", () => {
    expect(workloadRatioColor(0.79)).toBe(statusColors.warning);
    expect(workloadRatioColor(1.31)).toBe(statusColors.warning);
  });

  it("returns warning at exact boundaries 0.5 and 1.5", () => {
    expect(workloadRatioColor(0.5)).toBe(statusColors.warning);
    expect(workloadRatioColor(1.5)).toBe(statusColors.warning);
  });

  it("returns danger just outside caution range", () => {
    expect(workloadRatioColor(0.49)).toBe(statusColors.danger);
    expect(workloadRatioColor(1.51)).toBe(statusColors.danger);
  });

  it("returns danger for extreme values", () => {
    expect(workloadRatioColor(0.0)).toBe(statusColors.danger);
    expect(workloadRatioColor(3.0)).toBe(statusColors.danger);
  });
});

describe("workloadRatioHint", () => {
  it("returns optimal hint for 0.8-1.3", () => {
    expect(workloadRatioHint(0.8)).toBe("Optimal training zone");
    expect(workloadRatioHint(1.3)).toBe("Optimal training zone");
    expect(workloadRatioHint(1.0)).toBe("Optimal training zone");
  });

  it("returns detraining hint for < 0.8", () => {
    expect(workloadRatioHint(0.79)).toBe("Detraining risk - increase load gradually");
    expect(workloadRatioHint(0.0)).toBe("Detraining risk - increase load gradually");
  });

  it("returns high load hint for > 1.3 and <= 1.5", () => {
    expect(workloadRatioHint(1.31)).toBe("High load - monitor recovery closely");
    expect(workloadRatioHint(1.5)).toBe("High load - monitor recovery closely");
  });

  it("returns injury risk hint for > 1.5", () => {
    expect(workloadRatioHint(1.51)).toBe("Injury risk zone - consider rest");
    expect(workloadRatioHint(3.0)).toBe("Injury risk zone - consider rest");
  });
});

describe("aggregateWeeklyVolume", () => {
  it("aggregates duplicate weeks", () => {
    const result = aggregateWeeklyVolume([
      { week: "2024-01", hours: 3 },
      { week: "2024-01", hours: 2 },
      { week: "2024-02", hours: 4 },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ week: "2024-01", hours: 5, fraction: 1 });
    expect(result[1]).toEqual({ week: "2024-02", hours: 4, fraction: 0.8 });
  });

  it("limits to last 4 weeks", () => {
    const rows = [1, 2, 3, 4, 5].map((i) => ({
      week: `2024-0${i}`,
      hours: i,
    }));
    const result = aggregateWeeklyVolume(rows);
    expect(result).toHaveLength(4);
    // First week (lowest) should be dropped
    expect(result[0]?.week).toBe("2024-02");
  });

  it("sorts weeks chronologically", () => {
    const result = aggregateWeeklyVolume([
      { week: "2024-03", hours: 1 },
      { week: "2024-01", hours: 2 },
      { week: "2024-02", hours: 3 },
    ]);
    expect(result.map((r) => r.week)).toEqual(["2024-01", "2024-02", "2024-03"]);
  });

  it("handles empty input", () => {
    expect(aggregateWeeklyVolume([])).toEqual([]);
  });

  it("sets fraction relative to max hours", () => {
    const result = aggregateWeeklyVolume([
      { week: "2024-01", hours: 10 },
      { week: "2024-02", hours: 5 },
    ]);
    expect(result[0]?.fraction).toBe(1);
    expect(result[1]?.fraction).toBe(0.5);
  });

  it("handles single entry", () => {
    const result = aggregateWeeklyVolume([{ week: "2024-01", hours: 3 }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ week: "2024-01", hours: 3, fraction: 1 });
  });

  it("uses 1 as minimum denominator to avoid division by zero", () => {
    const result = aggregateWeeklyVolume([{ week: "2024-01", hours: 0 }]);
    expect(result[0]?.fraction).toBe(0);
  });
});

describe("trendDirection", () => {
  it("returns up when current > previous", () => {
    expect(trendDirection(10, 5)).toBe("up");
  });

  it("returns down when current < previous", () => {
    expect(trendDirection(5, 10)).toBe("down");
  });

  it("returns stable when equal", () => {
    expect(trendDirection(5, 5)).toBe("stable");
  });

  it("handles zero values", () => {
    expect(trendDirection(0, 0)).toBe("stable");
    expect(trendDirection(1, 0)).toBe("up");
    expect(trendDirection(0, 1)).toBe("down");
  });
});

describe("stressColor", () => {
  it("returns positive at boundary 0.5", () => {
    expect(stressColor(0.5)).toBe(statusColors.positive);
  });

  it("returns positive for zero", () => {
    expect(stressColor(0)).toBe(statusColors.positive);
  });

  it("returns warning just above 0.5", () => {
    expect(stressColor(0.51)).toBe(statusColors.warning);
  });

  it("returns warning at boundary 1.5", () => {
    expect(stressColor(1.5)).toBe(statusColors.warning);
  });

  it("returns elevated just above 1.5", () => {
    expect(stressColor(1.51)).toBe(statusColors.elevated);
  });

  it("returns elevated at boundary 2.5", () => {
    expect(stressColor(2.5)).toBe(statusColors.elevated);
  });

  it("returns danger just above 2.5", () => {
    expect(stressColor(2.51)).toBe(statusColors.danger);
  });

  it("returns danger for high values", () => {
    expect(stressColor(3)).toBe(statusColors.danger);
  });
});

describe("stressLabel", () => {
  it("returns Low at boundary 0.5", () => {
    expect(stressLabel(0.5)).toBe("Low");
  });

  it("returns Moderate just above 0.5", () => {
    expect(stressLabel(0.51)).toBe("Moderate");
  });

  it("returns Moderate at boundary 1.5", () => {
    expect(stressLabel(1.5)).toBe("Moderate");
  });

  it("returns High just above 1.5", () => {
    expect(stressLabel(1.51)).toBe("High");
  });

  it("returns High at boundary 2.5", () => {
    expect(stressLabel(2.5)).toBe("High");
  });

  it("returns Very High just above 2.5", () => {
    expect(stressLabel(2.51)).toBe("Very High");
  });
});

describe("trendColor", () => {
  it("returns positive for improving", () => {
    expect(trendColor("improving")).toBe(statusColors.positive);
  });

  it("returns danger for worsening", () => {
    expect(trendColor("worsening")).toBe(statusColors.danger);
  });

  it("returns neutral for stable", () => {
    expect(trendColor("stable")).toBe(textColors.neutral);
  });

  it("returns neutral for declining", () => {
    expect(trendColor("declining")).toBe(textColors.neutral);
  });
});

describe("rampRateColor", () => {
  it("returns positive for rate 0", () => {
    expect(rampRateColor(0)).toBe(statusColors.positive);
  });

  it("returns positive for rate just below 5", () => {
    expect(rampRateColor(4.99)).toBe(statusColors.positive);
  });

  it("returns warning at exactly 5", () => {
    expect(rampRateColor(5)).toBe(statusColors.warning);
  });

  it("returns warning at exactly 7", () => {
    expect(rampRateColor(7)).toBe(statusColors.warning);
  });

  it("returns danger just above 7", () => {
    expect(rampRateColor(7.01)).toBe(statusColors.danger);
  });

  it("returns danger for high rates", () => {
    expect(rampRateColor(15)).toBe(statusColors.danger);
  });

  it("uses absolute value for negative rates", () => {
    expect(rampRateColor(-3)).toBe(statusColors.positive);
    expect(rampRateColor(-5)).toBe(statusColors.warning);
    expect(rampRateColor(-7)).toBe(statusColors.warning);
    expect(rampRateColor(-8)).toBe(statusColors.danger);
  });
});

describe("sleepDebtColor", () => {
  it("returns positive for negative debt", () => {
    expect(sleepDebtColor(-10)).toBe(statusColors.positive);
  });

  it("returns positive at exactly 0", () => {
    expect(sleepDebtColor(0)).toBe(statusColors.positive);
  });

  it("returns warning at 1 (just above 0)", () => {
    expect(sleepDebtColor(1)).toBe(statusColors.warning);
  });

  it("returns warning at 119 (just below 120)", () => {
    expect(sleepDebtColor(119)).toBe(statusColors.warning);
  });

  it("returns danger at exactly 120", () => {
    expect(sleepDebtColor(120)).toBe(statusColors.danger);
  });

  it("returns danger for high debt", () => {
    expect(sleepDebtColor(300)).toBe(statusColors.danger);
  });
});

describe("formZoneColor", () => {
  it("returns transition color for values above transition boundary", () => {
    expect(formZoneColor(26)).toBe(FORM_ZONE_COLORS.transition);
    expect(formZoneColor(100)).toBe(FORM_ZONE_COLORS.transition);
  });

  it("returns fresh color at exactly transition boundary (not above)", () => {
    expect(formZoneColor(FORM_ZONE_TRANSITION)).toBe(FORM_ZONE_COLORS.fresh);
  });

  it("returns fresh color for values between fresh and transition", () => {
    expect(formZoneColor(6)).toBe(FORM_ZONE_COLORS.fresh);
    expect(formZoneColor(24)).toBe(FORM_ZONE_COLORS.fresh);
  });

  it("returns grey color at exactly fresh boundary (not above)", () => {
    expect(formZoneColor(FORM_ZONE_FRESH)).toBe(FORM_ZONE_COLORS.grey);
  });

  it("returns grey color for values between grey and fresh", () => {
    expect(formZoneColor(0)).toBe(FORM_ZONE_COLORS.grey);
    expect(formZoneColor(-9)).toBe(FORM_ZONE_COLORS.grey);
  });

  it("returns optimal color at exactly grey boundary (not above)", () => {
    expect(formZoneColor(FORM_ZONE_GREY)).toBe(FORM_ZONE_COLORS.optimal);
  });

  it("returns optimal color for values between optimal and grey", () => {
    expect(formZoneColor(-11)).toBe(FORM_ZONE_COLORS.optimal);
    expect(formZoneColor(-29)).toBe(FORM_ZONE_COLORS.optimal);
  });

  it("returns high risk color at exactly optimal boundary (not above)", () => {
    expect(formZoneColor(FORM_ZONE_OPTIMAL)).toBe(FORM_ZONE_COLORS.highRisk);
  });

  it("returns high risk color for values below optimal", () => {
    expect(formZoneColor(-31)).toBe(FORM_ZONE_COLORS.highRisk);
    expect(formZoneColor(-100)).toBe(FORM_ZONE_COLORS.highRisk);
  });
});

describe("formZoneLabel", () => {
  it("returns Transition for values above transition boundary", () => {
    expect(formZoneLabel(26)).toBe("Transition");
    expect(formZoneLabel(100)).toBe("Transition");
  });

  it("returns Fresh at exactly transition boundary", () => {
    expect(formZoneLabel(FORM_ZONE_TRANSITION)).toBe("Fresh");
  });

  it("returns Fresh for values between fresh and transition", () => {
    expect(formZoneLabel(10)).toBe("Fresh");
  });

  it("returns Grey Zone at exactly fresh boundary", () => {
    expect(formZoneLabel(FORM_ZONE_FRESH)).toBe("Grey Zone");
  });

  it("returns Grey Zone for values between grey and fresh", () => {
    expect(formZoneLabel(0)).toBe("Grey Zone");
  });

  it("returns Optimal at exactly grey boundary", () => {
    expect(formZoneLabel(FORM_ZONE_GREY)).toBe("Optimal");
  });

  it("returns Optimal for values between optimal and grey", () => {
    expect(formZoneLabel(-20)).toBe("Optimal");
  });

  it("returns High Risk at exactly optimal boundary", () => {
    expect(formZoneLabel(FORM_ZONE_OPTIMAL)).toBe("High Risk");
  });

  it("returns High Risk for values below optimal", () => {
    expect(formZoneLabel(-50)).toBe("High Risk");
  });
});
