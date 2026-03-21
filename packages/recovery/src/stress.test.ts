import { describe, expect, it } from "vitest";
import {
  aggregateWeeklyStress,
  computeDailyStress,
  computeStressTrend,
  type DailyStressInput,
  defaultStressThresholds,
} from "./stress.ts";

describe("computeDailyStress", () => {
  const defaults = defaultStressThresholds();

  it("returns 0 stress when all metrics are at baseline", () => {
    const input: DailyStressInput = {
      hrvDeviation: 0,
      restingHrDeviation: 0,
      sleepEfficiency: 95,
    };
    const result = computeDailyStress(input, defaults);
    expect(result.stressScore).toBe(0);
  });

  it("increases stress when HRV is below baseline", () => {
    const result = computeDailyStress(
      { hrvDeviation: -2.0, restingHrDeviation: 0, sleepEfficiency: 90 },
      defaults,
    );
    expect(result.stressScore).toBeGreaterThan(0);
    expect(result.stressScore).toBeLessThanOrEqual(3);
  });

  it("increases stress when resting HR is above baseline", () => {
    const result = computeDailyStress(
      { hrvDeviation: 0, restingHrDeviation: 2.0, sleepEfficiency: 90 },
      defaults,
    );
    expect(result.stressScore).toBeGreaterThan(0);
  });

  it("increases stress for poor sleep efficiency", () => {
    const low = computeDailyStress(
      { hrvDeviation: 0, restingHrDeviation: 0, sleepEfficiency: 65 },
      defaults,
    );
    const high = computeDailyStress(
      { hrvDeviation: 0, restingHrDeviation: 0, sleepEfficiency: 95 },
      defaults,
    );
    expect(low.stressScore).toBeGreaterThan(high.stressScore);
  });

  it("caps at 3.0", () => {
    const result = computeDailyStress(
      { hrvDeviation: -3.0, restingHrDeviation: 3.0, sleepEfficiency: 50 },
      defaults,
    );
    expect(result.stressScore).toBeLessThanOrEqual(3);
  });

  it("handles null deviations gracefully", () => {
    const result = computeDailyStress(
      { hrvDeviation: null, restingHrDeviation: null, sleepEfficiency: null },
      defaults,
    );
    expect(result.stressScore).toBe(0);
  });

  it("returns highest stress for severely depressed HRV", () => {
    const result = computeDailyStress(
      { hrvDeviation: -2.5, restingHrDeviation: 0, sleepEfficiency: 90 },
      defaults,
    );
    expect(result.stressScore).toBeGreaterThanOrEqual(1.5);
  });
});

describe("aggregateWeeklyStress", () => {
  it("groups daily scores into ISO weeks", () => {
    const daily = [
      { date: "2024-01-01", stressScore: 1.0 }, // Monday
      { date: "2024-01-02", stressScore: 2.0 },
      { date: "2024-01-03", stressScore: 1.5 },
      { date: "2024-01-04", stressScore: 0.5 },
      { date: "2024-01-05", stressScore: 1.0 },
      { date: "2024-01-06", stressScore: 0.0 },
      { date: "2024-01-07", stressScore: 0.5 },
    ];
    const weeks = aggregateWeeklyStress(daily);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]?.cumulativeStress).toBeCloseTo(6.5, 1);
    expect(weeks[0]?.avgDailyStress).toBeCloseTo(6.5 / 7, 1);
    expect(weeks[0]?.highStressDays).toBe(1); // only the 2.0 day
  });

  it("returns empty for empty input", () => {
    expect(aggregateWeeklyStress([])).toEqual([]);
  });
});

describe("computeStressTrend", () => {
  it("returns stable for fewer than 14 days", () => {
    const daily = Array.from({ length: 10 }, (_, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, "0")}`,
      stressScore: 1.0,
    }));
    expect(computeStressTrend(daily)).toBe("stable");
  });

  it("returns improving when recent stress is lower", () => {
    const daily = [
      ...Array.from({ length: 7 }, (_, i) => ({
        date: `2024-01-${String(i + 1).padStart(2, "0")}`,
        stressScore: 2.5,
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        date: `2024-01-${String(i + 8).padStart(2, "0")}`,
        stressScore: 0.5,
      })),
    ];
    expect(computeStressTrend(daily)).toBe("improving");
  });

  it("returns worsening when recent stress is higher", () => {
    const daily = [
      ...Array.from({ length: 7 }, (_, i) => ({
        date: `2024-01-${String(i + 1).padStart(2, "0")}`,
        stressScore: 0.5,
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        date: `2024-01-${String(i + 8).padStart(2, "0")}`,
        stressScore: 2.5,
      })),
    ];
    expect(computeStressTrend(daily)).toBe("worsening");
  });
});
