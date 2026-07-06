import { describe, expect, it } from "vitest";
import { enrichWeightPrediction } from "./enrichWeightPrediction.ts";

describe("enrichWeightPrediction", () => {
  const emptyPrediction = {
    ratePerWeek: null,
    rateConfidence: null,
    impliedDailyCalories: null,
    periodDeltas: { days7: null, days14: null, days30: null },
    goal: null,
    projectionLine: [],
  };

  it("returns prediction unchanged when rate is already available", () => {
    const prediction = {
      ...emptyPrediction,
      ratePerWeek: -0.3,
      impliedDailyCalories: -330,
    };

    expect(
      enrichWeightPrediction(prediction, [
        {
          date: "2026-07-01",
          rawWeight: 80,
          smoothedWeight: 80,
          weeklyChange: -0.2,
          interpolated: false,
        },
      ]),
    ).toBe(prediction);
  });

  it("fills rate from the latest weekly change in smoothed weight data", () => {
    const result = enrichWeightPrediction(emptyPrediction, [
      {
        date: "2026-06-24",
        rawWeight: 81,
        smoothedWeight: 81,
        weeklyChange: null,
        interpolated: false,
      },
      {
        date: "2026-07-01",
        rawWeight: 80.2,
        smoothedWeight: 80.2,
        weeklyChange: -0.4,
        interpolated: false,
      },
    ]);

    expect(result.ratePerWeek).toBe(-0.4);
    expect(result.impliedDailyCalories).toBeCloseTo(-440, 0);
  });

  it("omits impliedDailyCalories when weekly change is negligible", () => {
    const result = enrichWeightPrediction(emptyPrediction, [
      {
        date: "2026-07-01",
        rawWeight: 80,
        smoothedWeight: 80,
        weeklyChange: 0.005,
        interpolated: false,
      },
    ]);

    expect(result.ratePerWeek).toBe(0.005);
    expect(result.impliedDailyCalories).toBeNull();
  });

  it("includes impliedDailyCalories when weekly change is exactly the reportable threshold", () => {
    const result = enrichWeightPrediction(emptyPrediction, [
      {
        date: "2026-07-01",
        rawWeight: 80,
        smoothedWeight: 80,
        weeklyChange: 0.01,
        interpolated: false,
      },
    ]);

    expect(result.ratePerWeek).toBe(0.01);
    expect(result.impliedDailyCalories).not.toBeNull();
  });

  it("scans backward past a null latest entry to find an earlier weekly change", () => {
    const result = enrichWeightPrediction(emptyPrediction, [
      {
        date: "2026-06-24",
        rawWeight: 82,
        smoothedWeight: 82,
        weeklyChange: -0.6,
        interpolated: false,
      },
      {
        date: "2026-07-01",
        rawWeight: 81,
        smoothedWeight: 81,
        weeklyChange: null,
        interpolated: false,
      },
    ]);

    expect(result.ratePerWeek).toBe(-0.6);
  });

  it("ignores weekly changes outside the fallback scan window", () => {
    const rows = Array.from({ length: 35 }, (_, index) => ({
      date: `2026-05-${String(index + 1).padStart(2, "0")}`,
      rawWeight: 80,
      smoothedWeight: 80,
      weeklyChange: index === 0 ? -0.9 : null,
      interpolated: false,
    }));

    const result = enrichWeightPrediction(emptyPrediction, rows);

    expect(result.ratePerWeek).toBeNull();
  });

  it("returns the same prediction reference when no weekly change data is available", () => {
    const result = enrichWeightPrediction(emptyPrediction, []);

    expect(result).toBe(emptyPrediction);
  });
});
