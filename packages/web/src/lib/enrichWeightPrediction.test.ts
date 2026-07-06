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
});
