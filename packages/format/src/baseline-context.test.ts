import { describe, expect, it } from "vitest";
import {
  formatBaselineContext,
  formatComparisonContext,
  formatComparisonPeriod,
} from "./baseline-context.ts";
import { formatHRVMeasurement } from "./format.ts";

it("labels the recent and prior comparison periods without conflating their windows", () => {
  expect(formatComparisonPeriod({ recentDays: 7, baselineDays: 28 })).toBe("7d vs prior 28d");
  expect(formatComparisonPeriod({ recentDays: 14, baselineDays: 60 })).toBe("14d vs prior 60d");
});

describe("formatComparisonContext", () => {
  const comparison = {
    recentDays: 7,
    baselineDays: 28,
    recentMean: 66,
    baselineMean: 61,
    delta: 9,
  };
  const formatValue = (value: number) => formatHRVMeasurement(value).text;

  it("formats the supplied means and delta with platform measurement units", () => {
    expect(formatComparisonContext(comparison, { formatValue, missingMeans: "summary" })).toBe(
      "7d avg 66 ms vs prior 28d avg 61 ms · +9 ms",
    );
  });

  it.each([
    { delta: -5, expected: "-5 ms" },
    { delta: 0, expected: "0 ms" },
    { delta: null, expected: "—" },
  ])("preserves a supplied delta of $delta", ({ delta, expected }) => {
    expect(
      formatComparisonContext({ ...comparison, delta }, { formatValue, missingMeans: "values" }),
    ).toBe(`7d avg 66 ms vs prior 28d avg 61 ms · ${expected}`);
  });

  it.each([
    { recentMean: null, baselineMean: 61 },
    { recentMean: 66, baselineMean: null },
    { recentMean: null, baselineMean: null },
  ])("summarizes missing means with the summary policy %#", (means) => {
    expect(
      formatComparisonContext(
        { ...comparison, ...means },
        { formatValue, missingMeans: "summary" },
      ),
    ).toBe("7d vs prior 28d · Not enough comparison data");
  });

  it.each([
    { recentMean: null, baselineMean: 61, expected: "7d avg — vs prior 28d avg 61 · —" },
    { recentMean: 66, baselineMean: null, expected: "7d avg 66 vs prior 28d avg — · —" },
    { recentMean: null, baselineMean: null, expected: "7d avg — vs prior 28d avg — · —" },
  ])("renders missing means independently with the values policy %#", ({ expected, ...means }) => {
    expect(
      formatComparisonContext(
        { ...comparison, ...means, delta: null },
        { formatValue: String, missingMeans: "values" },
      ),
    ).toBe(expected);
  });
});

describe("formatBaselineContext", () => {
  const metric = {
    baseline: {
      mean: 60,
      sampleCount: 24,
      standardDeviation: 6,
      windowDays: 30,
      zScore: 2,
    },
    comparison: {
      baselineDays: 28,
      delta: 5,
      recentDays: 7,
    },
  };

  it("formats baseline, deviation, comparison, and coverage consistently", () => {
    expect(formatBaselineContext(metric, { unit: "ms" })).toBe(
      "30d baseline 60.0 ms ± 6.0 ms · 2.0 SD above baseline · 7d vs prior 28d +5.0 ms · 24/30 baseline days",
    );
  });

  it("supports platform measurement formatters", () => {
    expect(formatBaselineContext(metric, { formatter: formatHRVMeasurement })).toBe(
      "30d baseline 60 ms ± 6 ms · 2.0 SD above baseline · 7d vs prior 28d +5 ms · 24/30 baseline days",
    );
  });

  it("omits unavailable baseline context", () => {
    expect(
      formatBaselineContext({
        baseline: {
          mean: null,
          sampleCount: 0,
          standardDeviation: null,
          windowDays: 30,
          zScore: null,
        },
        comparison: {
          baselineDays: 28,
          delta: null,
          recentDays: 7,
        },
      }),
    ).toBe("0/30 baseline days");
  });

  it("formats negative deviations and deltas without a positive sign", () => {
    expect(
      formatBaselineContext(
        {
          baseline: {
            ...metric.baseline,
            standardDeviation: null,
            zScore: -1,
          },
          comparison: {
            ...metric.comparison,
            delta: -5,
          },
        },
        { unit: "ms" },
      ),
    ).toBe(
      "30d baseline 60.0 ms · 1.0 SD below baseline · 7d vs prior 28d -5.0 ms · 24/30 baseline days",
    );
  });

  it("formats zero deviation as at baseline and zero delta without a positive sign", () => {
    expect(
      formatBaselineContext(
        {
          baseline: {
            ...metric.baseline,
            zScore: 0,
          },
          comparison: {
            ...metric.comparison,
            delta: 0,
          },
        },
        { unit: "ms" },
      ),
    ).toBe(
      "30d baseline 60.0 ms ± 6.0 ms · 0.0 SD at baseline · 7d vs prior 28d 0.0 ms · 24/30 baseline days",
    );
  });
});
