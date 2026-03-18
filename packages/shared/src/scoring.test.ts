import { describe, expect, it } from "vitest";
import { statusColors, textColors } from "./colors.ts";
import {
  aggregateWeeklyVolume,
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

  it("returns warning for scores 50-70", () => {
    expect(scoreColor(50)).toBe(statusColors.warning);
    expect(scoreColor(70)).toBe(statusColors.warning);
  });

  it("returns danger for scores < 50", () => {
    expect(scoreColor(0)).toBe(statusColors.danger);
    expect(scoreColor(49)).toBe(statusColors.danger);
  });
});

describe("scoreLabel", () => {
  it("returns Recovered for scores > 70", () => {
    expect(scoreLabel(80)).toBe("Recovered");
  });

  it("returns Moderate for scores 50-70", () => {
    expect(scoreLabel(50)).toBe("Moderate");
  });

  it("returns Poor for scores < 50", () => {
    expect(scoreLabel(10)).toBe("Poor");
  });
});

describe("workloadRatioColor", () => {
  it("returns secondary color for null", () => {
    expect(workloadRatioColor(null)).toBe("#8e8e93");
  });

  it("returns positive for optimal range 0.8-1.3", () => {
    expect(workloadRatioColor(1.0)).toBe(statusColors.positive);
    expect(workloadRatioColor(0.8)).toBe(statusColors.positive);
    expect(workloadRatioColor(1.3)).toBe(statusColors.positive);
  });

  it("returns warning for caution range", () => {
    expect(workloadRatioColor(0.6)).toBe(statusColors.warning);
    expect(workloadRatioColor(1.4)).toBe(statusColors.warning);
  });

  it("returns danger for extreme values", () => {
    expect(workloadRatioColor(0.3)).toBe(statusColors.danger);
    expect(workloadRatioColor(2.0)).toBe(statusColors.danger);
  });
});

describe("workloadRatioHint", () => {
  it("returns optimal hint for 0.8-1.3", () => {
    expect(workloadRatioHint(1.0)).toBe("Optimal training zone");
  });

  it("returns detraining hint for < 0.8", () => {
    expect(workloadRatioHint(0.5)).toContain("Detraining");
  });

  it("returns high load hint for 1.3-1.5", () => {
    expect(workloadRatioHint(1.4)).toContain("High load");
  });

  it("returns injury risk hint for > 1.5", () => {
    expect(workloadRatioHint(2.0)).toContain("Injury risk");
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
    expect(aggregateWeeklyVolume(rows)).toHaveLength(4);
  });

  it("handles empty input", () => {
    expect(aggregateWeeklyVolume([])).toEqual([]);
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
});

describe("stressColor", () => {
  it("returns positive for low stress", () => {
    expect(stressColor(0.5)).toBe(statusColors.positive);
  });

  it("returns warning for moderate stress", () => {
    expect(stressColor(1.5)).toBe(statusColors.warning);
  });

  it("returns danger for very high stress", () => {
    expect(stressColor(3)).toBe(statusColors.danger);
  });
});

describe("stressLabel", () => {
  it("returns correct labels for each range", () => {
    expect(stressLabel(0.5)).toBe("Low");
    expect(stressLabel(1.5)).toBe("Moderate");
    expect(stressLabel(2.5)).toBe("High");
    expect(stressLabel(3.5)).toBe("Very High");
  });
});

describe("trendColor", () => {
  it("returns positive for improving", () => {
    expect(trendColor("improving")).toBe(statusColors.positive);
  });

  it("returns neutral for stable", () => {
    expect(trendColor("stable")).toBe(textColors.neutral);
  });

  it("returns neutral for declining", () => {
    expect(trendColor("declining")).toBe(textColors.neutral);
  });

  it("returns danger for worsening", () => {
    expect(trendColor("worsening")).toBe(statusColors.danger);
  });
});

describe("rampRateColor", () => {
  it("returns positive for safe rates (abs < 5)", () => {
    expect(rampRateColor(3)).toBe(statusColors.positive);
  });

  it("returns warning for moderate rates (abs <= 7)", () => {
    expect(rampRateColor(6)).toBe(statusColors.warning);
  });

  it("returns danger for high rates (abs > 7)", () => {
    expect(rampRateColor(15)).toBe(statusColors.danger);
  });

  it("uses absolute value for negative rates", () => {
    expect(rampRateColor(-3)).toBe(statusColors.positive);
    expect(rampRateColor(-6)).toBe(statusColors.warning);
    expect(rampRateColor(-15)).toBe(statusColors.danger);
  });
});

describe("sleepDebtColor", () => {
  it("returns positive for zero or negative debt", () => {
    expect(sleepDebtColor(0)).toBe(statusColors.positive);
    expect(sleepDebtColor(-10)).toBe(statusColors.positive);
  });

  it("returns warning for moderate debt (< 120)", () => {
    expect(sleepDebtColor(1)).toBe(statusColors.warning);
    expect(sleepDebtColor(60)).toBe(statusColors.warning);
    expect(sleepDebtColor(119)).toBe(statusColors.warning);
  });

  it("returns danger for high debt (>= 120)", () => {
    expect(sleepDebtColor(120)).toBe(statusColors.danger);
  });
});
