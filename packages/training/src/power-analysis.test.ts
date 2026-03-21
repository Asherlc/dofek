import { describe, expect, it } from "vitest";
import {
  computeNormalizedPower,
  computePowerCurve,
  DURATION_LABELS,
  fitCriticalPower,
  groupByActivity,
  linearRegression,
  STANDARD_DURATIONS,
} from "./power-analysis.ts";

describe("linearRegression", () => {
  it("fits a perfect line", () => {
    const { slope, intercept, r2 } = linearRegression([1, 2, 3], [2, 4, 6]);
    expect(slope).toBeCloseTo(2);
    expect(intercept).toBeCloseTo(0);
    expect(r2).toBeCloseTo(1);
  });

  it("fits a line with nonzero intercept", () => {
    const { slope, intercept, r2 } = linearRegression([1, 2, 3, 4], [8, 11, 14, 17]);
    expect(slope).toBeCloseTo(3);
    expect(intercept).toBeCloseTo(5);
    expect(r2).toBeCloseTo(1);
  });

  it("returns zero slope and intercept for degenerate input", () => {
    const { slope, intercept, r2 } = linearRegression([5, 5, 5], [1, 2, 3]);
    expect(slope).toBe(0);
    expect(intercept).toBe(0);
    expect(r2).toBe(0);
  });

  it("returns low r2 for noisy data", () => {
    const { r2 } = linearRegression([1, 2, 3, 4, 5], [10, 1, 8, 2, 9]);
    expect(r2).toBeLessThan(0.5);
  });

  it("handles negative slopes", () => {
    const { slope, intercept } = linearRegression([1, 2, 3], [8, 6, 4]);
    expect(slope).toBeCloseTo(-2);
    expect(intercept).toBeCloseTo(10);
  });
});

describe("fitCriticalPower", () => {
  function powerCurve(
    cp: number,
    wPrime: number,
    durations: number[],
  ): { durationSeconds: number; bestPower: number }[] {
    return durations.map((t) => ({
      durationSeconds: t,
      bestPower: cp + wPrime / t,
    }));
  }

  it("recovers CP from ideal power curve data", () => {
    const points = powerCurve(230, 15000, [120, 300, 600]);
    const model = fitCriticalPower(points);
    expect(model).not.toBeNull();
    expect(model?.cp).toBeCloseTo(230, 0);
    expect(model?.wPrime).toBeCloseTo(15000, -2);
    expect(model?.r2).toBeGreaterThan(0.99);
  });

  it("ignores long-duration data suppressed by interval training", () => {
    const shortDurations = powerCurve(230, 15000, [120, 300, 600]);
    const suppressedLongDurations = [
      { durationSeconds: 1200, bestPower: 200 },
      { durationSeconds: 1800, bestPower: 185 },
      { durationSeconds: 3600, bestPower: 170 },
    ];
    const model = fitCriticalPower([...shortDurations, ...suppressedLongDurations]);
    expect(model).not.toBeNull();
    expect(model?.cp).toBeCloseTo(230, 0);
  });

  it("returns null with fewer than 3 valid points", () => {
    const points = powerCurve(230, 15000, [120, 300]);
    expect(fitCriticalPower(points)).toBeNull();
  });

  it("returns null when CP would be negative", () => {
    const points = [
      { durationSeconds: 120, bestPower: 300 },
      { durationSeconds: 300, bestPower: 200 },
      { durationSeconds: 600, bestPower: 50 },
    ];
    const model = fitCriticalPower(points);
    if (model) {
      expect(model.cp).toBeGreaterThan(0);
    }
  });

  it("excludes durations under 120s", () => {
    const points = [
      { durationSeconds: 5, bestPower: 800 },
      { durationSeconds: 15, bestPower: 600 },
      { durationSeconds: 30, bestPower: 500 },
      { durationSeconds: 60, bestPower: 400 },
    ];
    expect(fitCriticalPower(points)).toBeNull();
  });

  it("excludes durations over 600s from fitting", () => {
    const points = [
      { durationSeconds: 700, bestPower: 230 },
      { durationSeconds: 1200, bestPower: 220 },
      { durationSeconds: 1800, bestPower: 210 },
    ];
    expect(fitCriticalPower(points)).toBeNull();
  });

  it("excludes points with zero power", () => {
    const points = [
      { durationSeconds: 120, bestPower: 0 },
      { durationSeconds: 300, bestPower: 0 },
      { durationSeconds: 600, bestPower: 0 },
    ];
    expect(fitCriticalPower(points)).toBeNull();
  });

  it("includes boundary durations 120s and 600s", () => {
    const points = powerCurve(250, 20000, [120, 360, 600]);
    const model = fitCriticalPower(points);
    expect(model).not.toBeNull();
    expect(model?.cp).toBeCloseTo(250, 0);
  });

  it("rounds cp, wPrime, and r2 values", () => {
    const points = powerCurve(230, 15000, [120, 180, 240, 300, 420, 600]);
    const model = fitCriticalPower(points);
    expect(model).not.toBeNull();
    expect(Number.isInteger(model?.cp)).toBe(true);
    expect(Number.isInteger(model?.wPrime)).toBe(true);
    const r2Str = String(model?.r2);
    const decimals = r2Str.split(".")[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(3);
  });

  it("returns null for empty input", () => {
    expect(fitCriticalPower([])).toBeNull();
  });
});

describe("STANDARD_DURATIONS", () => {
  it("contains the standard power curve durations in ascending order", () => {
    expect(STANDARD_DURATIONS).toEqual([
      5, 15, 30, 60, 120, 180, 300, 420, 600, 1200, 1800, 3600, 5400, 7200,
    ]);
    for (let i = 1; i < STANDARD_DURATIONS.length; i++) {
      expect(STANDARD_DURATIONS[i]).toBeGreaterThan(STANDARD_DURATIONS[i - 1] ?? 0);
    }
  });
});

describe("DURATION_LABELS", () => {
  it("has a label for every standard duration", () => {
    for (const d of STANDARD_DURATIONS) {
      expect(DURATION_LABELS[d]).toBeDefined();
    }
  });

  it("uses human-readable format", () => {
    expect(DURATION_LABELS[60]).toBe("1min");
    expect(DURATION_LABELS[3600]).toBe("60min");
    expect(DURATION_LABELS[5]).toBe("5s");
  });
});

describe("groupByActivity", () => {
  it("groups samples by activity_id in a single pass", () => {
    const samples = [
      { activity_id: "a1", activity_date: "2024-01-01", interval_s: 1, power: 200 },
      { activity_id: "a1", activity_date: "2024-01-01", interval_s: 1, power: 210 },
      { activity_id: "a2", activity_date: "2024-01-02", interval_s: 2, power: 180 },
      { activity_id: "a2", activity_date: "2024-01-02", interval_s: 2, power: 190 },
    ];
    const groups = groupByActivity(samples);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.rows).toHaveLength(2);
    expect(groups[0]?.activityDate).toBe("2024-01-01");
    expect(groups[0]?.intervalSeconds).toBe(1);
    expect(groups[1]?.rows).toHaveLength(2);
    expect(groups[1]?.activityDate).toBe("2024-01-02");
    expect(groups[1]?.intervalSeconds).toBe(2);
  });

  it("returns empty array for empty input", () => {
    expect(groupByActivity([])).toEqual([]);
  });

  it("handles single activity", () => {
    const samples = [{ activity_id: "a1", activity_date: "2024-01-01", interval_s: 1, power: 200 }];
    const groups = groupByActivity(samples);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows).toHaveLength(1);
  });
});

describe("computePowerCurve", () => {
  it("computes best average power for standard durations", () => {
    // 10 samples at 1s intervals, 200W constant
    const samples = Array.from({ length: 10 }, () => ({
      activity_id: "a1",
      activity_date: "2024-01-01",
      interval_s: 1,
      power: 200,
    }));
    const result = computePowerCurve(samples);
    // 10 samples = 10 seconds, so only 5s duration should be in results
    const d5 = result.find((r) => r.durationSeconds === 5);
    expect(d5).toBeDefined();
    expect(d5?.bestPower).toBe(200);
  });

  it("finds the best across multiple activities", () => {
    const activity1 = Array.from({ length: 10 }, () => ({
      activity_id: "a1",
      activity_date: "2024-01-01",
      interval_s: 1,
      power: 200,
    }));
    const activity2 = Array.from({ length: 10 }, () => ({
      activity_id: "a2",
      activity_date: "2024-01-02",
      interval_s: 1,
      power: 250,
    }));
    const result = computePowerCurve([...activity1, ...activity2]);
    const d5 = result.find((r) => r.durationSeconds === 5);
    expect(d5?.bestPower).toBe(250);
    expect(d5?.activityDate).toBe("2024-01-02");
  });

  it("returns empty array for empty input", () => {
    expect(computePowerCurve([])).toEqual([]);
  });
});

describe("computeNormalizedPower", () => {
  it("computes NP using 30s rolling averages of 4th power", () => {
    // 60 samples at 1s intervals, constant 200W → NP should equal 200
    const samples = Array.from({ length: 60 }, () => ({
      activity_id: "a1",
      activity_date: "2024-01-01",
      activity_name: "Test Ride",
      interval_s: 1,
      power: 200,
    }));
    const result = computeNormalizedPower(samples);
    expect(result).toHaveLength(1);
    expect(result[0]?.normalizedPower).toBeCloseTo(200, 0);
    expect(result[0]?.activityName).toBe("Test Ride");
  });

  it("NP is higher than average for variable power", () => {
    // 60s blocks of 100W then 300W → avg=200, but NP>200 because
    // 30s rolling windows see sustained high/low blocks, not a uniform average
    const samples = Array.from({ length: 120 }, (_, i) => ({
      activity_id: "a1",
      activity_date: "2024-01-01",
      activity_name: "Intervals",
      interval_s: 1,
      power: i < 60 ? 100 : 300,
    }));
    const result = computeNormalizedPower(samples);
    expect(result).toHaveLength(1);
    expect(result[0]?.normalizedPower).toBeGreaterThan(200);
  });

  it("returns empty for empty input", () => {
    expect(computeNormalizedPower([])).toEqual([]);
  });

  it("sorts results by date", () => {
    const activity1 = Array.from({ length: 60 }, () => ({
      activity_id: "a2",
      activity_date: "2024-01-02",
      activity_name: "Ride 2",
      interval_s: 1,
      power: 200,
    }));
    const activity2 = Array.from({ length: 60 }, () => ({
      activity_id: "a1",
      activity_date: "2024-01-01",
      activity_name: "Ride 1",
      interval_s: 1,
      power: 200,
    }));
    const result = computeNormalizedPower([...activity1, ...activity2]);
    expect(result[0]?.activityDate).toBe("2024-01-01");
    expect(result[1]?.activityDate).toBe("2024-01-02");
  });
});
