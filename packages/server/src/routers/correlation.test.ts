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

  it("correctly extracts all metric types from JoinedDay", () => {
    const day = makeDay({
      date: "2025-01-01",
      resting_hr: 60,
      hrv: 50,
      spo2_avg: 98,
      skin_temp_c: 36.5,
      sleep_duration_min: 480,
      deep_min: 100,
      rem_min: 80,
      sleep_efficiency: 85,
      calories: 2000,
      protein_g: 100,
      carbs_g: 250,
      fat_g: 70,
      fiber_g: 30,
      steps: 10000,
      active_energy_kcal: 500,
      exercise_minutes: 60,
      cardio_minutes: 30,
      strength_minutes: 20,
      weight_kg: 75,
      body_fat_pct: 20,
      weight_30d_avg: 74.5,
    });

    expect(extractMetricValue(day, "resting_hr")).toBe(60);
    expect(extractMetricValue(day, "hrv")).toBe(50);
    expect(extractMetricValue(day, "spo2")).toBe(98);
    expect(extractMetricValue(day, "skin_temp")).toBe(36.5);
    expect(extractMetricValue(day, "sleep_duration")).toBe(480);
    expect(extractMetricValue(day, "calories")).toBe(2000);
    expect(extractMetricValue(day, "protein")).toBe(100);
    expect(extractMetricValue(day, "steps")).toBe(10000);
    expect(extractMetricValue(day, "weight")).toBe(75);
    expect(extractMetricValue(day, "body_fat")).toBe(20);
  });

  it("handles edge case with exactly MAX_DATA_POINTS data points", () => {
    const days: JoinedDay[] = [];
    for (let i = 0; i < 300; i++) {
      days.push(
        makeDay({
          date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
          steps: 5000 + i,
          calories: 2000 + i,
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
    expect(result.sampleCount).toBe(300);
  });

  it("returns consistent stats when computed with different lag values", () => {
    const days = generateCorrelatedDays(30);
    const result0 = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 0,
    });
    const result1 = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 1,
    });

    expect(result0.sampleCount).toBeGreaterThan(result1.sampleCount);
    expect(result0.dataPoints.length).toBeGreaterThan(0);
    expect(result1.dataPoints.length).toBeGreaterThan(0);
  });

  it("returns neutral color for insufficient data", () => {
    const days = generateCorrelatedDays(3);
    const result = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 0,
    });
    expect(result.correlationColor).toBe("#71717a");
  });

  it("uses metric labels in insight text", () => {
    const days = generateCorrelatedDays(30);
    const result = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 0,
    });
    // Verify labels are used (not raw IDs)
    expect(result.insight).toContain("protein");
    expect(result.insight).not.toContain("protein_g");
  });
});
