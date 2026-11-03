import { describe, expect, it } from "vitest";
import { sleepStageColors, statusColors, textColors } from "./colors.ts";
import {
  aggregateWeeklyVolume,
  FORM_ZONE_COLORS,
  FORM_ZONE_FRESH,
  FORM_ZONE_GREY,
  FORM_ZONE_OPTIMAL,
  FORM_ZONE_TRANSITION,
  FormZone,
  healthStatusColor,
  SCORE_RECOVERED_THRESHOLD,
  SCORE_WARNING_THRESHOLD,
  SCORE_ZONES,
  StressScore,
  scoreColor,
  scoreLabel,
  trendColor,
  trendDirection,
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

describe("SCORE_ZONES", () => {
  it("matches the scoreColor threshold constants", () => {
    expect(SCORE_ZONES).toEqual([
      { min: 0, max: SCORE_WARNING_THRESHOLD, status: "danger" },
      { min: SCORE_WARNING_THRESHOLD, max: SCORE_RECOVERED_THRESHOLD, status: "warning" },
      { min: SCORE_RECOVERED_THRESHOLD, max: 100, status: "positive" },
    ]);
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

describe("sleepStageColors", () => {
  it("has all four sleep stages", () => {
    expect(sleepStageColors.deep).toBe("#5E35B1");
    expect(sleepStageColors.rem).toBe("#42A5F5");
    expect(sleepStageColors.light).toBe("#78909C");
    expect(sleepStageColors.awake).toBe("#FF8A65");
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
