import { describe, expect, it } from "vitest";
import {
  baselineRelativeMetricSchema,
  buildBaselineRelativeMetric,
} from "./baseline-relative-metrics.ts";

describe("buildBaselineRelativeMetric", () => {
  it("returns the server-owned baseline and increasing comparison", () => {
    expect(
      buildBaselineRelativeMetric({
        metric: "hrv",
        label: "Heart Rate Variability (HRV)",
        value: 72,
        baselineMean: 60,
        baselineStandardDeviation: 6,
        zScore: 2,
        baselineSampleCount: 24,
        baselineCoverage: 0.8,
        recentMean: 66,
        comparisonMean: 61,
      }),
    ).toEqual({
      metric: "hrv",
      label: "Heart Rate Variability (HRV)",
      value: 72,
      baseline: {
        windowDays: 30,
        mean: 60,
        standardDeviation: 6,
        zScore: 2,
        sampleCount: 24,
        coverage: 0.8,
      },
      comparison: {
        recentDays: 7,
        baselineDays: 28,
        recentMean: 66,
        baselineMean: 61,
        delta: 5,
        direction: "increasing",
      },
    });
  });

  it("keeps a one-sample baseline visible while unavailable variation stays null", () => {
    const metric = buildBaselineRelativeMetric({
      metric: "sleep_efficiency",
      label: "Sleep Efficiency",
      value: 82,
      baselineMean: 80,
      baselineStandardDeviation: null,
      zScore: null,
      baselineSampleCount: 1,
      baselineCoverage: 1 / 30,
      recentMean: 82,
      comparisonMean: null,
    });

    expect(metric.baseline).toMatchObject({
      mean: 80,
      standardDeviation: null,
      zScore: null,
      sampleCount: 1,
      coverage: 1 / 30,
    });
    expect(metric.comparison).toMatchObject({
      delta: null,
      direction: "unknown",
    });
    expect(baselineRelativeMetricSchema.parse(metric)).toEqual(metric);
  });

  it.each([
    { recentMean: 50, comparisonMean: 55, direction: "decreasing" },
    { recentMean: 50, comparisonMean: 50, direction: "stable" },
  ] as const)("classifies $direction comparison direction", (input) => {
    expect(
      buildBaselineRelativeMetric({
        metric: "resting_heart_rate",
        label: "Resting Heart Rate",
        value: 50,
        baselineMean: 55,
        baselineStandardDeviation: 2,
        zScore: -2.5,
        baselineSampleCount: 30,
        baselineCoverage: 1,
        recentMean: input.recentMean,
        comparisonMean: input.comparisonMean,
      }).comparison.direction,
    ).toBe(input.direction);
  });
});
