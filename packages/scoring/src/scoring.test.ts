import { describe, expect, it } from "vitest";
import { statusColors, textColors } from "./colors.ts";
import {
  aggregateWeeklyVolume,
  FORM_ZONE_COLORS,
  FORM_ZONE_FRESH,
  FORM_ZONE_GREY,
  FORM_ZONE_OPTIMAL,
  FORM_ZONE_TRANSITION,
  FormZone,
  healthStatusColor,
  rampRateColor,
  readinessLevelColor,
  StrainScore,
  StrainZone,
  StressScore,
  scoreColor,
  scoreLabel,
  sleepDebtColor,
  trendColor,
  trendDirection,
  WorkloadRatio,
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

describe("WorkloadRatio", () => {
  describe("color", () => {
    it("returns secondary color for null", () => {
      expect(new WorkloadRatio(null).color).toBe(textColors.secondary);
    });

    it("returns positive at exact boundaries 0.8 and 1.3", () => {
      expect(new WorkloadRatio(0.8).color).toBe(statusColors.positive);
      expect(new WorkloadRatio(1.3).color).toBe(statusColors.positive);
    });

    it("returns positive in the middle of optimal range", () => {
      expect(new WorkloadRatio(1.0).color).toBe(statusColors.positive);
    });

    it("returns warning just outside optimal range", () => {
      expect(new WorkloadRatio(0.79).color).toBe(statusColors.warning);
      expect(new WorkloadRatio(1.31).color).toBe(statusColors.warning);
    });

    it("returns warning at exact boundaries 0.5 and 1.5", () => {
      expect(new WorkloadRatio(0.5).color).toBe(statusColors.warning);
      expect(new WorkloadRatio(1.5).color).toBe(statusColors.warning);
    });

    it("returns danger just outside caution range", () => {
      expect(new WorkloadRatio(0.49).color).toBe(statusColors.danger);
      expect(new WorkloadRatio(1.51).color).toBe(statusColors.danger);
    });

    it("returns danger for extreme values", () => {
      expect(new WorkloadRatio(0.0).color).toBe(statusColors.danger);
      expect(new WorkloadRatio(3.0).color).toBe(statusColors.danger);
    });
  });

  describe("hint", () => {
    it("returns null for null", () => {
      expect(new WorkloadRatio(null).hint).toBeNull();
    });

    it("returns optimal hint for 0.8-1.3", () => {
      expect(new WorkloadRatio(0.8).hint).toBe("Optimal training zone");
      expect(new WorkloadRatio(1.3).hint).toBe("Optimal training zone");
      expect(new WorkloadRatio(1.0).hint).toBe("Optimal training zone");
    });

    it("returns detraining hint for < 0.8", () => {
      expect(new WorkloadRatio(0.79).hint).toBe("Detraining risk - increase load gradually");
      expect(new WorkloadRatio(0.0).hint).toBe("Detraining risk - increase load gradually");
    });

    it("returns high load hint for > 1.3 and <= 1.5", () => {
      expect(new WorkloadRatio(1.31).hint).toBe("High load - monitor recovery closely");
      expect(new WorkloadRatio(1.5).hint).toBe("High load - monitor recovery closely");
    });

    it("returns injury risk hint for > 1.5", () => {
      expect(new WorkloadRatio(1.51).hint).toBe("Injury risk zone - consider rest");
      expect(new WorkloadRatio(3.0).hint).toBe("Injury risk zone - consider rest");
    });
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

describe("StressScore", () => {
  describe("color", () => {
    it("returns positive at boundary 0.5", () => {
      expect(new StressScore(0.5).color).toBe(statusColors.positive);
    });

    it("returns positive for zero", () => {
      expect(new StressScore(0).color).toBe(statusColors.positive);
    });

    it("returns warning just above 0.5", () => {
      expect(new StressScore(0.51).color).toBe(statusColors.warning);
    });

    it("returns warning at boundary 1.5", () => {
      expect(new StressScore(1.5).color).toBe(statusColors.warning);
    });

    it("returns elevated just above 1.5", () => {
      expect(new StressScore(1.51).color).toBe(statusColors.elevated);
    });

    it("returns elevated at boundary 2.5", () => {
      expect(new StressScore(2.5).color).toBe(statusColors.elevated);
    });

    it("returns danger just above 2.5", () => {
      expect(new StressScore(2.51).color).toBe(statusColors.danger);
    });

    it("returns danger for high values", () => {
      expect(new StressScore(3).color).toBe(statusColors.danger);
    });
  });

  describe("label", () => {
    it("returns Low at boundary 0.5", () => {
      expect(new StressScore(0.5).label).toBe("Low");
    });

    it("returns Moderate just above 0.5", () => {
      expect(new StressScore(0.51).label).toBe("Moderate");
    });

    it("returns Moderate at boundary 1.5", () => {
      expect(new StressScore(1.5).label).toBe("Moderate");
    });

    it("returns High just above 1.5", () => {
      expect(new StressScore(1.51).label).toBe("High");
    });

    it("returns High at boundary 2.5", () => {
      expect(new StressScore(2.5).label).toBe("High");
    });

    it("returns Very High just above 2.5", () => {
      expect(new StressScore(2.51).label).toBe("Very High");
    });
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

  it("returns danger for declining", () => {
    expect(trendColor("declining")).toBe(statusColors.danger);
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

describe("FormZone", () => {
  describe("color", () => {
    it("returns transition color for values above transition boundary", () => {
      expect(new FormZone(26).color).toBe(FORM_ZONE_COLORS.transition);
      expect(new FormZone(100).color).toBe(FORM_ZONE_COLORS.transition);
    });

    it("returns fresh color at exactly transition boundary (not above)", () => {
      expect(new FormZone(FORM_ZONE_TRANSITION).color).toBe(FORM_ZONE_COLORS.fresh);
    });

    it("returns fresh color for values between fresh and transition", () => {
      expect(new FormZone(6).color).toBe(FORM_ZONE_COLORS.fresh);
      expect(new FormZone(24).color).toBe(FORM_ZONE_COLORS.fresh);
    });

    it("returns grey color at exactly fresh boundary (not above)", () => {
      expect(new FormZone(FORM_ZONE_FRESH).color).toBe(FORM_ZONE_COLORS.grey);
    });

    it("returns grey color for values between grey and fresh", () => {
      expect(new FormZone(0).color).toBe(FORM_ZONE_COLORS.grey);
      expect(new FormZone(-9).color).toBe(FORM_ZONE_COLORS.grey);
    });

    it("returns optimal color at exactly grey boundary (not above)", () => {
      expect(new FormZone(FORM_ZONE_GREY).color).toBe(FORM_ZONE_COLORS.optimal);
    });

    it("returns optimal color for values between optimal and grey", () => {
      expect(new FormZone(-11).color).toBe(FORM_ZONE_COLORS.optimal);
      expect(new FormZone(-29).color).toBe(FORM_ZONE_COLORS.optimal);
    });

    it("returns high risk color at exactly optimal boundary (not above)", () => {
      expect(new FormZone(FORM_ZONE_OPTIMAL).color).toBe(FORM_ZONE_COLORS.highRisk);
    });

    it("returns high risk color for values below optimal", () => {
      expect(new FormZone(-31).color).toBe(FORM_ZONE_COLORS.highRisk);
      expect(new FormZone(-100).color).toBe(FORM_ZONE_COLORS.highRisk);
    });
  });

  describe("label", () => {
    it("returns Transition for values above transition boundary", () => {
      expect(new FormZone(26).label).toBe("Transition");
      expect(new FormZone(100).label).toBe("Transition");
    });

    it("returns Fresh at exactly transition boundary", () => {
      expect(new FormZone(FORM_ZONE_TRANSITION).label).toBe("Fresh");
    });

    it("returns Fresh for values between fresh and transition", () => {
      expect(new FormZone(10).label).toBe("Fresh");
    });

    it("returns Grey Zone at exactly fresh boundary", () => {
      expect(new FormZone(FORM_ZONE_FRESH).label).toBe("Grey Zone");
    });

    it("returns Grey Zone for values between grey and fresh", () => {
      expect(new FormZone(0).label).toBe("Grey Zone");
    });

    it("returns Optimal at exactly grey boundary", () => {
      expect(new FormZone(FORM_ZONE_GREY).label).toBe("Optimal");
    });

    it("returns Optimal for values between optimal and grey", () => {
      expect(new FormZone(-20).label).toBe("Optimal");
    });

    it("returns High Risk at exactly optimal boundary", () => {
      expect(new FormZone(FORM_ZONE_OPTIMAL).label).toBe("High Risk");
    });

    it("returns High Risk for values below optimal", () => {
      expect(new FormZone(-50).label).toBe("High Risk");
    });
  });
});

describe("readinessLevelColor", () => {
  it("returns positive for high", () => {
    expect(readinessLevelColor("high")).toBe(statusColors.positive);
  });

  it("returns warning for moderate", () => {
    expect(readinessLevelColor("moderate")).toBe(statusColors.warning);
  });

  it("returns danger for low", () => {
    expect(readinessLevelColor("low")).toBe(statusColors.danger);
  });

  it("returns neutral for unknown", () => {
    expect(readinessLevelColor("unknown")).toBe(textColors.neutral);
  });
});

describe("healthStatusColor", () => {
  it("returns positive for excellent", () => {
    expect(healthStatusColor("excellent")).toBe(statusColors.positive);
  });

  it("returns info for good", () => {
    expect(healthStatusColor("good")).toBe(statusColors.info);
  });

  it("returns warning for fair", () => {
    expect(healthStatusColor("fair")).toBe(statusColors.warning);
  });

  it("returns danger for poor", () => {
    expect(healthStatusColor("poor")).toBe(statusColors.danger);
  });
});

describe("StrainZone", () => {
  describe("color", () => {
    it("returns positive for optimal", () => {
      expect(new StrainZone("optimal").color).toBe(statusColors.positive);
    });

    it("returns danger for overreaching", () => {
      expect(new StrainZone("overreaching").color).toBe(statusColors.danger);
    });

    it("returns info for restoring", () => {
      expect(new StrainZone("restoring").color).toBe(statusColors.info);
    });

    it("returns secondary for unknown zone", () => {
      expect(new StrainZone("unknown").color).toBe(textColors.secondary);
    });
  });

  describe("label", () => {
    it("returns Optimal for optimal", () => {
      expect(new StrainZone("optimal").label).toBe("Optimal");
    });

    it("returns Overreaching for overreaching", () => {
      expect(new StrainZone("overreaching").label).toBe("Overreaching");
    });

    it("returns Restoring for restoring", () => {
      expect(new StrainZone("restoring").label).toBe("Restoring");
    });

    it("returns the zone string for unknown zones", () => {
      expect(new StrainZone("something").label).toBe("something");
    });
  });
});

describe("StrainScore", () => {
  describe("fromRawLoad", () => {
    it("returns 0 for zero raw load", () => {
      expect(StrainScore.fromRawLoad(0).value).toBe(0);
    });

    it("returns 0 for negative raw load", () => {
      expect(StrainScore.fromRawLoad(-5).value).toBe(0);
    });

    it("maps a light 30-min workout (~20 raw) to light strain (8-11)", () => {
      const strain = StrainScore.fromRawLoad(19.5);
      expect(strain.value).toBeGreaterThanOrEqual(8);
      expect(strain.value).toBeLessThanOrEqual(11);
    });

    it("maps a moderate 60-min workout (~45 raw) to moderate strain (12-14)", () => {
      const strain = StrainScore.fromRawLoad(45);
      expect(strain.value).toBeGreaterThanOrEqual(12);
      expect(strain.value).toBeLessThanOrEqual(14);
    });

    it("maps a hard 90-min workout (~76 raw) to high strain (14-16)", () => {
      const strain = StrainScore.fromRawLoad(76);
      expect(strain.value).toBeGreaterThanOrEqual(14);
      expect(strain.value).toBeLessThanOrEqual(16);
    });

    it("maps a very hard 2-hour workout (~96 raw) to high strain (15-17)", () => {
      const strain = StrainScore.fromRawLoad(96);
      expect(strain.value).toBeGreaterThanOrEqual(15);
      expect(strain.value).toBeLessThanOrEqual(17);
    });

    it("maps an extreme 3-hour endurance effort (~141 raw) to very high strain (17-19)", () => {
      const strain = StrainScore.fromRawLoad(141);
      expect(strain.value).toBeGreaterThanOrEqual(17);
      expect(strain.value).toBeLessThanOrEqual(19);
    });

    it("never exceeds 21 even for extreme values", () => {
      expect(StrainScore.fromRawLoad(500).value).toBeLessThanOrEqual(21);
      expect(StrainScore.fromRawLoad(1000).value).toBeLessThanOrEqual(21);
    });

    it("increases monotonically with raw load", () => {
      let previous = StrainScore.fromRawLoad(0).value;
      for (const load of [10, 20, 50, 100, 200, 500]) {
        const current = StrainScore.fromRawLoad(load).value;
        expect(current).toBeGreaterThan(previous);
        previous = current;
      }
    });

    it("shows diminishing returns at higher loads (logarithmic behavior)", () => {
      const lowGain = StrainScore.fromRawLoad(50).value - StrainScore.fromRawLoad(0).value;
      const highGain = StrainScore.fromRawLoad(150).value - StrainScore.fromRawLoad(100).value;
      expect(lowGain).toBeGreaterThan(highGain);
    });

    it("returns a rounded value with 1 decimal place", () => {
      const strain = StrainScore.fromRawLoad(45);
      expect(strain.value).toBe(Math.round(strain.value * 10) / 10);
    });
  });

  describe("color", () => {
    it("returns textSecondary for light strain (< 10)", () => {
      expect(new StrainScore(5).color).toBe(textColors.secondary);
      expect(new StrainScore(9.9).color).toBe(textColors.secondary);
    });

    it("returns positive for moderate strain (10-13)", () => {
      expect(new StrainScore(10).color).toBe(statusColors.positive);
      expect(new StrainScore(13).color).toBe(statusColors.positive);
    });

    it("returns warning for high strain (14-17)", () => {
      expect(new StrainScore(14).color).toBe(statusColors.warning);
      expect(new StrainScore(17).color).toBe(statusColors.warning);
    });

    it("returns danger for all-out strain (> 17)", () => {
      expect(new StrainScore(17.1).color).toBe(statusColors.danger);
      expect(new StrainScore(21).color).toBe(statusColors.danger);
    });
  });

  describe("label", () => {
    it("returns Light for strain < 10", () => {
      expect(new StrainScore(5).label).toBe("Light");
      expect(new StrainScore(0).label).toBe("Light");
    });

    it("returns Moderate for strain 10-13", () => {
      expect(new StrainScore(10).label).toBe("Moderate");
      expect(new StrainScore(13).label).toBe("Moderate");
    });

    it("returns High for strain 14-17", () => {
      expect(new StrainScore(14).label).toBe("High");
      expect(new StrainScore(17).label).toBe("High");
    });

    it("returns All Out for strain > 17", () => {
      expect(new StrainScore(17.1).label).toBe("All Out");
      expect(new StrainScore(21).label).toBe("All Out");
    });
  });
});
