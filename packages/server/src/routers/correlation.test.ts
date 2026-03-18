import { describe, expect, it } from "vitest";
import type { JoinedDay } from "../insights/engine.ts";
import { computeCorrelation, extractMetricValue } from "./correlation.ts";

function makeDay(overrides: Partial<JoinedDay> & { date: string }): JoinedDay {
  return {
    resting_hr: null,
    hrv: null,
    spo2_avg: null,
    steps: null,
    active_energy_kcal: null,
    skin_temp_c: null,
    sleep_duration_min: null,
    deep_min: null,
    rem_min: null,
    sleep_efficiency: null,
    exercise_minutes: null,
    cardio_minutes: null,
    strength_minutes: null,
    flexibility_minutes: null,
    calories: null,
    protein_g: null,
    carbs_g: null,
    fat_g: null,
    fiber_g: null,
    weight_kg: null,
    body_fat_pct: null,
    weight_30d_avg: null,
    body_fat_30d_avg: null,
    weight_30d_delta: null,
    body_fat_30d_delta: null,
    ...overrides,
  };
}

describe("extractMetricValue", () => {
  it("extracts a known metric from a JoinedDay", () => {
    const day = makeDay({ date: "2025-01-01", hrv: 55 });
    expect(extractMetricValue(day, "hrv")).toBe(55);
  });

  it("returns null for a metric with no data", () => {
    const day = makeDay({ date: "2025-01-01" });
    expect(extractMetricValue(day, "hrv")).toBeNull();
  });

  it("returns null for an unknown metric id", () => {
    const day = makeDay({ date: "2025-01-01", hrv: 55 });
    expect(extractMetricValue(day, "nonexistent")).toBeNull();
  });
});

describe("computeCorrelation", () => {
  function generateCorrelatedDays(n: number): JoinedDay[] {
    const days: JoinedDay[] = [];
    for (let i = 0; i < n; i++) {
      const date = `2025-01-${String(i + 1).padStart(2, "0")}`;
      days.push(
        makeDay({
          date,
          protein_g: 100 + i * 2,
          hrv: 50 + i, // Perfectly correlated with protein
        }),
      );
    }
    return days;
  }

  it("computes correlation between two metrics with sufficient data", () => {
    const days = generateCorrelatedDays(30);
    const result = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 0,
    });

    expect(result.sampleCount).toBe(30);
    expect(result.spearmanRho).toBeCloseTo(1, 1);
    expect(result.pearsonR).toBeCloseTo(1, 1);
    expect(result.regression.rSquared).toBeCloseTo(1, 1);
    expect(result.confidenceLevel).toBe("strong");
    expect(result.dataPoints.length).toBe(30);
    expect(result.insight).toContain("protein");
    expect(result.insight).toContain("heart rate variability");
  });

  it("returns insufficient results when too few data points", () => {
    const days = generateCorrelatedDays(3);
    const result = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 0,
    });

    expect(result.sampleCount).toBeLessThan(5);
    expect(result.confidenceLevel).toBe("insufficient");
  });

  it("supports lag > 0 to offset metrics by days", () => {
    // Create data where protein today correlates with HRV tomorrow
    const days: JoinedDay[] = [];
    for (let i = 0; i < 30; i++) {
      days.push(
        makeDay({
          date: `2025-01-${String(i + 1).padStart(2, "0")}`,
          protein_g: 100 + i * 5,
          hrv: i > 0 ? 50 + (i - 1) : 50, // HRV follows previous day's protein pattern
        }),
      );
    }

    const result = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 1,
    });

    expect(result.sampleCount).toBe(29); // one less due to lag
    expect(result.insight).toMatch(/next.day|1.day later/i);
  });

  it("downsamples data points when too many", () => {
    const days: JoinedDay[] = [];
    for (let i = 0; i < 500; i++) {
      days.push(
        makeDay({
          date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
          steps: 5000 + i * 10,
          calories: 2000 + i * 5,
        }),
      );
    }

    const result = computeCorrelation(days, {
      metricX: "steps",
      metricY: "calories",
      days: 365,
      lag: 0,
    });

    expect(result.dataPoints.length).toBeLessThanOrEqual(300);
  });

  it("handles metrics with mostly null values", () => {
    const days: JoinedDay[] = [];
    for (let i = 0; i < 30; i++) {
      days.push(
        makeDay({
          date: `2025-01-${String(i + 1).padStart(2, "0")}`,
          hrv: i % 10 === 0 ? 55 : null, // only 3 non-null values
          steps: 8000 + i * 100,
        }),
      );
    }

    const result = computeCorrelation(days, {
      metricX: "hrv",
      metricY: "steps",
      days: 365,
      lag: 0,
    });

    expect(result.sampleCount).toBeLessThan(5);
    expect(result.confidenceLevel).toBe("insufficient");
  });

  it("includes descriptive stats for both axes", () => {
    const days = generateCorrelatedDays(30);
    const result = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 0,
    });

    expect(result.xStats.mean).toBeGreaterThan(0);
    expect(result.xStats.min).toBeLessThanOrEqual(result.xStats.max);
    expect(result.yStats.mean).toBeGreaterThan(0);
    expect(result.yStats.n).toBe(30);
  });
});
