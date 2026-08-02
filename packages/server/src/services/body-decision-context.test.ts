import { describe, expect, it } from "vitest";
import {
  BODY_TREND_WEIGHT_ALPHA,
  BODY_VARIATION_MAX_OBSERVATIONS,
  BODY_VARIATION_MIN_OBSERVATIONS,
  type BodyDecisionMeasurement,
  buildBodyDecisionContext,
} from "./body-decision-context.ts";

function measurement(
  date: string,
  weightKg: number,
  overrides: Partial<BodyDecisionMeasurement> = {},
): BodyDecisionMeasurement {
  return {
    date,
    recordedAt: `${date}T08:00:00.000Z`,
    recordedAtLocal: `${date} 08:00:00`,
    weightKg,
    providerId: "withings",
    sourceName: "Body+",
    ...overrides,
  };
}

function trend(date: string, smoothedWeight: number) {
  return { date, smoothedWeight };
}

describe("buildBodyDecisionContext", () => {
  it("reports the latest selected measurement provenance", () => {
    const context = buildBodyDecisionContext(
      [
        measurement("2026-07-01", 80),
        measurement("2026-07-02", 80.2, {
          recordedAt: "2026-07-02T07:15:00.000Z",
          recordedAtLocal: "2026-07-02 07:15:00",
          providerId: "apple_health",
          sourceName: "Apple Watch",
        }),
      ],
      [trend("2026-07-01", 80), trend("2026-07-02", 80.02)],
    );

    expect(context.latestMeasurement).toEqual({
      date: "2026-07-02",
      recordedAt: "2026-07-02T07:15:00.000Z",
      recordedAtLocal: "2026-07-02 07:15:00",
      weightKg: 80.2,
      providerId: "apple_health",
      sourceName: "Apple Watch",
    });
  });

  it("uses the latest 30 residuals and Tukey inner fences without dropping observations", () => {
    const measurements = Array.from({ length: 31 }, (_, index) => {
      const date = `2026-06-${String(index + 1).padStart(2, "0")}`;
      return measurement(date, 80 + (index === 30 ? 1.5 : 0));
    });
    const trends = measurements.map((row) => trend(row.date, 80));

    const context = buildBodyDecisionContext(measurements, trends);

    expect(context.variation).toMatchObject({
      status: "available",
      observations: BODY_VARIATION_MAX_OBSERVATIONS,
      minimumObservations: BODY_VARIATION_MIN_OBSERVATIONS,
      maximumObservations: BODY_VARIATION_MAX_OBSERVATIONS,
      method: "tukey_inner_fence",
      outliersIncluded: true,
    });
    expect(context.variation.lowerResidualKg).toBe(0);
    expect(context.variation.upperResidualKg).toBe(0);
  });

  it("returns an explicit insufficient-data state below the minimum", () => {
    const measurements = Array.from({ length: BODY_VARIATION_MIN_OBSERVATIONS - 1 }, (_, index) => {
      const date = `2026-07-${String(index + 1).padStart(2, "0")}`;
      return measurement(date, 80 + index / 10);
    });

    const context = buildBodyDecisionContext(
      measurements,
      measurements.map((row) => trend(row.date, row.weightKg)),
    );

    expect(context.variation).toEqual({
      status: "insufficient_data",
      observations: BODY_VARIATION_MIN_OBSERVATIONS - 1,
      minimumObservations: BODY_VARIATION_MIN_OBSERVATIONS,
      maximumObservations: BODY_VARIATION_MAX_OBSERVATIONS,
      method: "tukey_inner_fence",
      lowerResidualKg: null,
      upperResidualKg: null,
      outliersIncluded: true,
    });
  });

  it("states the exact Trend Weight handling contract", () => {
    const context = buildBodyDecisionContext([], []);

    expect(context.trendWeight).toEqual({
      smoothing: "ewma",
      alpha: BODY_TREND_WEIGHT_ALPHA,
      gapHandling: "linear_interpolation",
      invalidWeightHandling: "exclude_non_positive",
      outlierHandling: "retain",
    });
  });
});
