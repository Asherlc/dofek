import { describe, expect, it } from "vitest";
import { colors } from "../theme";
import {
  aggregateWeeklyVolume,
  scoreColor,
  scoreLabel,
  trendDirection,
  WorkloadRatio,
} from "./scoring";

describe("scoreColor", () => {
  it("returns positive for scores > 70", () => {
    expect(scoreColor(80)).toBe(colors.positive);
    expect(scoreColor(71)).toBe(colors.positive);
  });

  it("returns warning for scores 50-70", () => {
    expect(scoreColor(50)).toBe(colors.warning);
    expect(scoreColor(70)).toBe(colors.warning);
  });

  it("returns danger for scores < 50", () => {
    expect(scoreColor(10)).toBe(colors.danger);
    expect(scoreColor(49)).toBe(colors.danger);
  });
});

describe("scoreLabel", () => {
  it("returns Recovered for high scores", () => {
    expect(scoreLabel(80)).toBe("Recovered");
  });

  it("returns Moderate for mid scores", () => {
    expect(scoreLabel(50)).toBe("Moderate");
  });

  it("returns Poor for low scores", () => {
    expect(scoreLabel(10)).toBe("Poor");
  });
});

describe("WorkloadRatio", () => {
  describe("color", () => {
    it("returns textSecondary for null", () => {
      expect(new WorkloadRatio(null).color).toBe(colors.textSecondary);
    });

    it("returns positive for sweet spot (0.8-1.3)", () => {
      expect(new WorkloadRatio(1.0).color).toBe(colors.positive);
      expect(new WorkloadRatio(0.8).color).toBe(colors.positive);
      expect(new WorkloadRatio(1.3).color).toBe(colors.positive);
    });

    it("returns warning for caution zone", () => {
      expect(new WorkloadRatio(0.6).color).toBe(colors.warning);
      expect(new WorkloadRatio(1.4).color).toBe(colors.warning);
    });

    it("returns danger for extreme values", () => {
      expect(new WorkloadRatio(0.3).color).toBe(colors.danger);
      expect(new WorkloadRatio(2.0).color).toBe(colors.danger);
    });
  });

  describe("hint", () => {
    it("returns optimal for sweet spot", () => {
      expect(new WorkloadRatio(1.0).hint).toBe("Optimal training zone");
    });

    it("returns detraining risk for low ratio", () => {
      expect(new WorkloadRatio(0.5).hint).toBe("Detraining risk - increase load gradually");
    });

    it("returns high load warning", () => {
      expect(new WorkloadRatio(1.4).hint).toBe("High load - monitor recovery closely");
    });

    it("returns injury risk for very high ratio", () => {
      expect(new WorkloadRatio(2.0).hint).toBe("Injury risk zone - consider rest");
    });
  });
});

describe("aggregateWeeklyVolume", () => {
  it("aggregates duplicate weeks", () => {
    const result = aggregateWeeklyVolume([
      { week: "2024-01-01", hours: 3 },
      { week: "2024-01-01", hours: 2 },
      { week: "2024-01-08", hours: 4 },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      week: "2024-01-01",
      hours: 5,
      fraction: 1,
    });
    expect(result[1]).toEqual({
      week: "2024-01-08",
      hours: 4,
      fraction: 4 / 5,
    });
  });

  it("returns at most 4 weeks", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      week: `2024-0${i + 1}-01`,
      hours: i + 1,
    }));
    const result = aggregateWeeklyVolume(rows);
    expect(result).toHaveLength(4);
  });

  it("sorts weeks chronologically", () => {
    const result = aggregateWeeklyVolume([
      { week: "2024-01-15", hours: 2 },
      { week: "2024-01-01", hours: 3 },
      { week: "2024-01-08", hours: 1 },
    ]);
    expect(result.map((r) => r.week)).toEqual(["2024-01-01", "2024-01-08", "2024-01-15"]);
  });

  it("handles empty input", () => {
    expect(aggregateWeeklyVolume([])).toEqual([]);
  });

  it("sets fraction relative to max hours", () => {
    const result = aggregateWeeklyVolume([
      { week: "2024-01-01", hours: 10 },
      { week: "2024-01-08", hours: 5 },
    ]);
    expect(result[0]?.fraction).toBe(1);
    expect(result[1]?.fraction).toBe(0.5);
  });
});

describe("trendDirection", () => {
  it("returns up when current > previous", () => {
    expect(trendDirection(50, 40)).toBe("up");
  });

  it("returns down when current < previous", () => {
    expect(trendDirection(40, 50)).toBe("down");
  });

  it("returns stable when values are equal", () => {
    expect(trendDirection(50, 50)).toBe("stable");
  });
});
