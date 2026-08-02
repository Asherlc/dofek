import { describe, expect, it } from "vitest";
import { buildBaselineRelativeMetric } from "../contracts/baseline-relative-metrics.ts";
import {
  buildDailyMetricHealthStatuses,
  buildHealthMetricEvidence,
  buildHealthStatusFromBaselineMetric,
  buildHealthStatusFromSummary,
  buildHealthStatusFromValues,
  buildWeightHealthStatus,
  resolveWeightGoalIntent,
} from "./health-status.ts";

describe("buildDailyMetricHealthStatuses", () => {
  it("uses a layman-readable blood oxygen label", () => {
    const statuses = buildDailyMetricHealthStatuses(
      {
        avg_hrv: null,
        avg_resting_hr: null,
        avg_spo2: 97,
        avg_steps: null,
        avg_skin_temp: null,
        stddev_hrv: null,
        stddev_resting_hr: null,
        stddev_spo2: 1,
        stddev_steps: null,
        stddev_skin_temp: null,
        latest_hrv: null,
        latest_resting_hr: null,
        latest_spo2: 98,
        latest_steps: null,
        latest_skin_temp: null,
        latest_date: "2026-07-25",
        latest_steps_date: null,
      },
      [],
    );

    expect(statuses.find((status) => status.metric === "spo2")?.label).toBe(
      "Blood Oxygen Saturation (SpO2)",
    );
  });

  it("uses canonical recovery baselines instead of selected-range aggregates", () => {
    const statuses = buildDailyMetricHealthStatuses(
      {
        avg_hrv: 68,
        avg_resting_hr: null,
        avg_spo2: null,
        avg_steps: null,
        avg_skin_temp: null,
        stddev_hrv: 1,
        stddev_resting_hr: null,
        stddev_spo2: null,
        stddev_steps: null,
        stddev_skin_temp: null,
        latest_hrv: 72,
        latest_resting_hr: null,
        latest_spo2: null,
        latest_steps: null,
        latest_skin_temp: null,
        latest_date: "2026-07-25",
        latest_steps_date: null,
      },
      [
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
      ],
    );

    expect(statuses.find((status) => status.metric === "hrv")).toMatchObject({
      baseline: 60,
      sampleDeviation: 6,
      deviation: 2,
    });
  });

  it.each([
    { metric: "hrv" as const, intent: "higher", statusToken: "moving_as_intended" },
    {
      metric: "resting_heart_rate" as const,
      intent: "lower",
      statusToken: "far_from_baseline",
    },
    {
      metric: "respiratory_rate" as const,
      intent: "lower",
      statusToken: "far_from_baseline",
    },
    {
      metric: "sleep_efficiency" as const,
      intent: "higher",
      statusToken: "moving_as_intended",
    },
  ])("applies the supported intent for $metric", ({ metric, intent, statusToken }) => {
    const baselineMetric = buildBaselineRelativeMetric({
      metric,
      label: metric,
      value: 16,
      baselineMean: 14,
      baselineStandardDeviation: 1,
      zScore: 2,
      baselineSampleCount: 30,
      baselineCoverage: 1,
      recentMean: 15,
      comparisonMean: 14,
    });

    expect(buildHealthStatusFromBaselineMetric(baselineMetric)).toMatchObject({
      metric,
      intent,
      direction: "above",
      statusToken,
    });
  });
});

describe("buildHealthMetricEvidence", () => {
  it.each([
    "hrv",
    "spo2",
    "steps",
    "skin_temperature",
  ] as const)("authors provenance and personal comparison context for %s", (_metric) => {
    expect(
      buildHealthMetricEvidence(
        [
          { date: "2026-07-01", value: 60, sourceProviders: ["garmin"] },
          { date: "2026-07-25", value: 66, sourceProviders: ["whoop"] },
          { date: "2026-07-30", value: 72, sourceProviders: ["whoop"] },
        ],
        30,
      ),
    ).toEqual({
      provenance: {
        latestDate: "2026-07-30",
        sourceProviders: ["whoop"],
        observedDays: 3,
        windowDays: 30,
      },
      comparison: {
        recentDays: 7,
        baselineDays: 28,
        recentMean: 69,
        baselineMean: 60,
        delta: 9,
        direction: "increasing",
      },
    });
  });
});

describe("buildHealthStatusFromSummary", () => {
  it.each([
    {
      metric: "hrv" as const,
      value: 51.5,
      baseline: 50.5,
      valueText: "52 ms",
      baselineText: "51 ms",
    },
    {
      metric: "steps" as const,
      value: 7639.6,
      baseline: 7640,
      valueText: "7,640",
      baselineText: "7,640",
    },
  ])("authors $metric current and baseline display text", (fixture) => {
    expect(
      buildHealthStatusFromSummary({
        metric: fixture.metric,
        label: fixture.metric,
        value: fixture.value,
        baseline: fixture.baseline,
        sampleDeviation: 10,
        intent: "neutral",
      }),
    ).toMatchObject({
      value: fixture.value,
      baseline: fixture.baseline,
      valueText: fixture.valueText,
      baselineText: fixture.baselineText,
    });
  });

  it("leaves unit-sensitive display text to the client", () => {
    expect(
      buildHealthStatusFromSummary({
        metric: "skin_temperature",
        label: "Skin Temperature",
        value: 34.4,
        baseline: 34,
        sampleDeviation: 0.5,
        intent: "neutral",
      }),
    ).toMatchObject({ valueText: null, baselineText: null });
  });

  it("treats a positive deviation as moving as intended when higher values are supported", () => {
    expect(
      buildHealthStatusFromSummary({
        metric: "hrv",
        label: "Heart Rate Variability (HRV)",
        value: 65,
        baseline: 50,
        sampleDeviation: 10,
        intent: "higher",
      }),
    ).toMatchObject({
      deviation: 1.5,
      direction: "above",
      intent: "higher",
      statusToken: "moving_as_intended",
      statusColor: "positive",
      statusLabel: "Moving as intended",
      evaluationRule: "Above your baseline, where higher values support this metric",
    });
  });

  it("classifies a negative deviation against a supported higher-value direction", () => {
    expect(
      buildHealthStatusFromSummary({
        metric: "hrv",
        label: "Heart Rate Variability (HRV)",
        value: 35,
        baseline: 50,
        sampleDeviation: 10,
        intent: "higher",
      }),
    ).toMatchObject({
      deviation: -1.5,
      direction: "below",
      statusToken: "notable_deviation",
      statusColor: "warning",
      statusLabel: "Notably below baseline",
      evaluationRule:
        "Outside your usual range: 1 to less than 2 standard deviations from baseline",
    });
  });

  it.each([
    {
      value: 59.999,
      statusToken: "near_baseline",
      evaluationRule: "Within your usual range: less than 1 standard deviation from baseline",
    },
    {
      value: 60,
      statusToken: "notable_deviation",
      evaluationRule:
        "Outside your usual range: 1 to less than 2 standard deviations from baseline",
    },
    {
      value: 70,
      statusToken: "far_from_baseline",
      evaluationRule: "Well outside your usual range: at least 2 standard deviations from baseline",
    },
  ])("returns the exact evaluated rule at value $value", ({
    value,
    statusToken,
    evaluationRule,
  }) => {
    expect(
      buildHealthStatusFromSummary({
        metric: "skin_temperature",
        label: "Skin Temperature",
        value,
        baseline: 50,
        sampleDeviation: 10,
        intent: "neutral",
      }),
    ).toMatchObject({ statusToken, evaluationRule });
  });

  it.each([
    { value: 70, direction: "above" as const, deviation: 2 },
    { value: 30, direction: "below" as const, deviation: -2 },
  ])("uses neutral language for a $direction deviation", ({ value, direction, deviation }) => {
    const result = buildHealthStatusFromSummary({
      metric: "body_fat_percentage",
      label: "Body Fat %",
      value,
      baseline: 50,
      sampleDeviation: 10,
      intent: "neutral",
    });

    expect(result).toMatchObject({
      deviation,
      direction,
      statusToken: "far_from_baseline",
      statusColor: "danger",
      statusLabel: `Far ${direction} baseline`,
    });
    expect(result.explanation).not.toMatch(/abnormal|normal/i);
  });

  it.each([
    { value: null, baseline: 50, sampleDeviation: 10 },
    { value: 50, baseline: null, sampleDeviation: 10 },
    { value: 50, baseline: 50, sampleDeviation: null },
    { value: 50, baseline: 50, sampleDeviation: 0 },
  ])("returns an insufficient-data DTO for missing or zero variance", (input) => {
    expect(
      buildHealthStatusFromSummary({
        metric: "skin_temperature",
        label: "Skin Temperature",
        intent: "neutral",
        ...input,
      }),
    ).toMatchObject({
      deviation: null,
      direction: "unknown",
      statusToken: "insufficient_data",
      statusColor: "muted",
      statusLabel: "Not enough data",
      evaluationRule: "Needs a current value, baseline, and measurable day-to-day variation",
    });
  });
});

describe("buildHealthStatusFromValues", () => {
  it("computes the baseline mean and sample deviation on the server", () => {
    expect(
      buildHealthStatusFromValues({
        metric: "steps",
        label: "Steps",
        values: [70, 72, 74],
        intent: "neutral",
      }),
    ).toMatchObject({
      value: 74,
      baseline: 72,
      sampleDeviation: 2,
      deviation: 1,
      direction: "above",
      statusToken: "notable_deviation",
    });
  });
});

describe("resolveWeightGoalIntent", () => {
  it("returns loss intent when the goal is below both the current value and baseline", () => {
    expect(resolveWeightGoalIntent({ goalWeightKg: 70, currentWeightKg: 80, baselineKg: 82 })).toBe(
      "lower",
    );
  });

  it("returns gain intent when the goal is above both the current value and baseline", () => {
    expect(resolveWeightGoalIntent({ goalWeightKg: 90, currentWeightKg: 82, baselineKg: 80 })).toBe(
      "higher",
    );
  });

  it("returns maintenance intent when the goal is aligned with the current range", () => {
    expect(resolveWeightGoalIntent({ goalWeightKg: 81, currentWeightKg: 81, baselineKg: 80 })).toBe(
      "maintain",
    );
  });

  it("returns neutral intent when no goal is configured", () => {
    expect(
      resolveWeightGoalIntent({ goalWeightKg: null, currentWeightKg: 81, baselineKg: 80 }),
    ).toBe("neutral");
  });
});

describe("buildWeightHealthStatus", () => {
  it.each([
    {
      goalWeightKg: 70,
      values: [82, 80],
      intent: "lower",
      statusToken: "moving_as_intended",
    },
    {
      goalWeightKg: 90,
      values: [80, 82],
      intent: "higher",
      statusToken: "moving_as_intended",
    },
    {
      goalWeightKg: 81,
      values: [80, 82],
      intent: "maintain",
      statusToken: "near_baseline",
    },
  ])("classifies weight using $intent goal intent", ({
    goalWeightKg,
    values,
    intent,
    statusToken,
  }) => {
    expect(buildWeightHealthStatus(values, goalWeightKg)).toMatchObject({
      intent,
      statusToken,
    });
  });
});
