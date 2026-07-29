import { describe, expect, it } from "vitest";
import { formatBaselineContext } from "./baseline-context.ts";
import { formatHRVMeasurement } from "./format.ts";

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
});
