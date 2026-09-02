import { describe, expect, it } from "vitest";
import { buildBaselineRelativeMetric } from "../contracts/baseline-relative-metrics.ts";
import {
  buildDailyMetricHealthStatuses,
  buildHealthMetricEvidence,
  buildHealthStatusFromBaselineMetric,
  buildHealthStatusFromSummary,
  buildHealthStatusFromValues,
  buildRestingHeartRateTrendLabel,
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
        sample_count_hrv: 0,
        sample_count_resting_hr: 0,
        sample_count_spo2: 1,
        sample_count_steps: 0,
        sample_count_skin_temp: 0,
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
        sample_count_hrv: 1,
        sample_count_resting_hr: 0,
        sample_count_spo2: 0,
        sample_count_steps: 0,
        sample_count_skin_temp: 0,
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
    expect(statuses.filter((status) => status.metric === "resting_heart_rate")).toHaveLength(1);
  });

  it("uses the canonical resting heart rate baseline without adding a duplicate trend status", () => {
    const statuses = buildDailyMetricHealthStatuses(
      {
        avg_hrv: null,
        avg_resting_hr: 54,
        avg_spo2: null,
        avg_steps: null,
        avg_skin_temp: null,
        stddev_hrv: null,
        stddev_resting_hr: 2,
        stddev_spo2: null,
        stddev_steps: null,
        stddev_skin_temp: null,
        latest_hrv: null,
        latest_resting_hr: 52,
        latest_spo2: null,
        latest_steps: null,
        latest_skin_temp: null,
        sample_count_hrv: 0,
        sample_count_resting_hr: 3,
        sample_count_spo2: 0,
        sample_count_steps: 0,
        sample_count_skin_temp: 0,
        latest_date: "2026-07-25",
        latest_steps_date: null,
      },
      [
        buildBaselineRelativeMetric({
          metric: "resting_heart_rate",
          label: "Resting Heart Rate",
          value: 52,
          baselineMean: 54,
          baselineStandardDeviation: 2,
          zScore: -1,
          baselineSampleCount: 30,
          baselineCoverage: 1,
          recentMean: 52,
          comparisonMean: 54,
        }),
      ],
    );

    expect(statuses.filter((status) => status.metric === "resting_heart_rate")).toHaveLength(1);
    expect(statuses.find((status) => status.metric === "resting_heart_rate")).toMatchObject({
      value: 52,
      baseline: 54,
      sampleDeviation: 2,
    });
  });

  it("uses each aggregate metric's server-provided observation count", () => {
    const statuses = buildDailyMetricHealthStatuses(
      {
        avg_hrv: null,
        avg_resting_hr: null,
        avg_spo2: 97,
        avg_steps: 100,
        avg_skin_temp: 36,
        stddev_hrv: null,
        stddev_resting_hr: null,
        stddev_spo2: 1,
        stddev_steps: 10,
        stddev_skin_temp: 0.1,
        latest_hrv: null,
        latest_resting_hr: null,
        latest_spo2: 98,
        latest_steps: 120,
        latest_skin_temp: 36.2,
        sample_count_hrv: 0,
        sample_count_resting_hr: 0,
        sample_count_spo2: 3,
        sample_count_steps: 4,
        sample_count_skin_temp: 5,
        latest_date: "2026-07-25",
        latest_steps_date: "2026-07-25",
      },
      [],
    );

    expect(statuses.find((status) => status.metric === "spo2")?.baselineProgress).toMatchObject({
      observedObservationDays: 3,
    });
    expect(statuses.find((status) => status.metric === "steps")?.baselineProgress).toMatchObject({
      observedObservationDays: 4,
    });
    expect(
      statuses.find((status) => status.metric === "skin_temperature")?.baselineProgress,
    ).toMatchObject({ observedObservationDays: 5 });
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

  it("attaches metric evidence only to the matching HRV baseline status", () => {
    const statuses = buildDailyMetricHealthStatuses(
      {
        avg_hrv: 60,
        avg_resting_hr: null,
        avg_spo2: null,
        avg_steps: null,
        avg_skin_temp: null,
        stddev_hrv: 5,
        stddev_resting_hr: null,
        stddev_spo2: null,
        stddev_steps: null,
        stddev_skin_temp: null,
        latest_hrv: 70,
        latest_resting_hr: null,
        latest_spo2: null,
        latest_steps: null,
        latest_skin_temp: null,
        latest_date: "2026-07-25",
        latest_steps_date: null,
        metric_evidence: {
          hrv: {
            latestDate: "2026-07-25",
            sourceProviders: ["whoop"],
            observedDays: 12,
            recentMean: 70,
            baselineMean: 60,
          },
          spo2: null,
          steps: null,
          skin_temperature: null,
        },
      },
      [
        buildBaselineRelativeMetric({
          metric: "hrv",
          label: "Heart Rate Variability (HRV)",
          value: 70,
          baselineMean: 60,
          baselineStandardDeviation: 5,
          zScore: 2,
          baselineSampleCount: 12,
          baselineCoverage: 1,
          recentMean: 70,
          comparisonMean: 60,
        }),
        buildBaselineRelativeMetric({
          metric: "resting_heart_rate",
          label: "Resting Heart Rate",
          value: 55,
          baselineMean: 60,
          baselineStandardDeviation: 5,
          zScore: -1,
          baselineSampleCount: 12,
          baselineCoverage: 1,
          recentMean: 55,
          comparisonMean: 60,
        }),
      ],
      null,
      35,
    );

    expect(statuses.find((status) => status.metric === "hrv")).toMatchObject({
      provenance: {
        latestDate: "2026-07-25",
        sourceProviders: ["whoop"],
        observedDays: 12,
        windowDays: 35,
      },
    });
    expect(statuses.find((status) => status.metric === "resting_heart_rate")).toMatchObject({
      provenance: null,
    });
  });

  it("keeps evidence deltas null when either comparison mean is missing", () => {
    const statuses = buildDailyMetricHealthStatuses(
      {
        avg_hrv: null,
        avg_resting_hr: null,
        avg_spo2: 98,
        avg_steps: 8_000,
        avg_skin_temp: null,
        stddev_hrv: null,
        stddev_resting_hr: null,
        stddev_spo2: 1,
        stddev_steps: 1_000,
        stddev_skin_temp: null,
        latest_hrv: null,
        latest_resting_hr: null,
        latest_spo2: 98,
        latest_steps: 8_000,
        latest_skin_temp: null,
        latest_date: "2026-07-25",
        latest_steps_date: "2026-07-25",
        metric_evidence: {
          hrv: null,
          spo2: {
            latestDate: "2026-07-25",
            sourceProviders: ["garmin"],
            observedDays: 3,
            recentMean: 98,
            baselineMean: null,
          },
          steps: {
            latestDate: "2026-07-25",
            sourceProviders: ["apple_health"],
            observedDays: 3,
            recentMean: null,
            baselineMean: 8_000,
          },
          skin_temperature: null,
        },
      },
      [],
    );

    expect(statuses.find((status) => status.metric === "spo2")?.comparison).toMatchObject({
      delta: null,
      direction: "unknown",
    });
    expect(statuses.find((status) => status.metric === "steps")?.comparison).toMatchObject({
      delta: null,
      direction: "unknown",
    });
  });
});

describe("buildHealthMetricEvidence", () => {
  it.each(["hrv", "spo2", "steps", "skin_temperature"] as const)(
    "authors provenance and personal comparison context for %s",
    (_metric) => {
      expect(
        buildHealthMetricEvidence(
          [
            { date: "2026-07-25", value: 66, sourceProviders: ["whoop"] },
            { date: "2026-07-30", value: 72, sourceProviders: ["whoop", "garmin", "whoop"] },
            { date: "2026-07-01", value: 60, sourceProviders: ["garmin"] },
            { date: "2026-07-31", value: Number.NaN, sourceProviders: ["invalid"] },
          ],
          30,
        ),
      ).toEqual({
        provenance: {
          latestDate: "2026-07-30",
          sourceProviders: ["garmin", "whoop"],
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
    },
  );

  it("keeps recent and baseline comparison boundaries exclusive", () => {
    expect(
      buildHealthMetricEvidence(
        [
          { date: "2026-06-25", value: 50, sourceProviders: ["garmin"] },
          { date: "2026-07-01", value: 60, sourceProviders: ["garmin"] },
          { date: "2026-07-23", value: 100, sourceProviders: ["garmin"] },
          { date: "2026-07-25", value: 66, sourceProviders: ["whoop"] },
          { date: "2026-07-30", value: 72, sourceProviders: ["whoop"] },
        ],
        35,
      ).comparison,
    ).toEqual({
      recentDays: 7,
      baselineDays: 28,
      recentMean: 69,
      baselineMean: 80,
      delta: -11,
      direction: "decreasing",
    });
  });

  it("returns stable and unknown comparisons for zero or incomplete baselines", () => {
    expect(
      buildHealthMetricEvidence(
        [
          { date: "2026-07-01", value: 60, sourceProviders: ["whoop"] },
          { date: "2026-07-25", value: 60, sourceProviders: ["whoop"] },
          { date: "2026-07-30", value: 60, sourceProviders: ["whoop"] },
        ],
        35,
      ).comparison,
    ).toMatchObject({ delta: 0, direction: "stable" });

    expect(
      buildHealthMetricEvidence([{ date: "2026-07-30", value: 60, sourceProviders: ["whoop"] }], 35)
        .comparison,
    ).toMatchObject({ recentMean: 60, baselineMean: null, delta: null, direction: "unknown" });
  });

  it("returns empty provenance when no finite observations exist", () => {
    expect(buildHealthMetricEvidence([], 35)).toEqual({
      provenance: {
        latestDate: null,
        sourceProviders: [],
        observedDays: 0,
        windowDays: 35,
      },
      comparison: {
        recentDays: 7,
        baselineDays: 28,
        recentMean: null,
        baselineMean: null,
        delta: null,
        direction: "unknown",
      },
    });
  });
});

describe("buildRestingHeartRateTrendLabel", () => {
  it("waits for the baseline before comparing a current value", () => {
    expect(
      buildRestingHeartRateTrendLabel({
        latest: 48,
        average: 54,
        baselineProgress: { blocker: "collecting" },
      }),
    ).toBe("Waiting for baseline");
  });

  it.each([
    { latest: null, average: 54 },
    { latest: 48, average: null },
  ])("waits when the $latest/$average comparison value is missing", ({ latest, average }) => {
    expect(
      buildRestingHeartRateTrendLabel({
        latest,
        average,
        baselineProgress: { blocker: null },
      }),
    ).toBe("Waiting for baseline");
  });

  it.each([
    { latest: 48, average: 54, label: "below average" },
    { latest: 60, average: 54, label: "above average" },
    { latest: 54, average: 54, label: "at average" },
  ])(
    "returns the server-owned comparison label for $latest/$average",
    ({ latest, average, label }) => {
      expect(
        buildRestingHeartRateTrendLabel({
          latest,
          average,
          baselineProgress: { blocker: null },
        }),
      ).toBe(label);
    },
  );
});

describe("buildHealthStatusFromSummary", () => {
  it("includes server-authored baseline requirements and action for insufficient data", () => {
    const result = buildHealthStatusFromSummary({
      metric: "resting_heart_rate",
      label: "Resting Heart Rate",
      value: 56,
      baseline: 56,
      sampleDeviation: null,
      intent: "lower",
      observedDays: 1,
      processingStatus: null,
    });

    expect(result).toMatchObject({
      statusToken: "insufficient_data",
      baselineProgress: {
        observedObservationDays: 1,
        blocker: "collecting",
        requirement:
          "A current value plus at least 2 more recorded days with measurable variation.",
        summary:
          "Resting Heart Rate has 1 of 3 required days recorded; the baseline is still collecting observations.",
        action: "Keep syncing resting heart rate data for at least 2 more days.",
      },
    });
  });

  it.each([
    {
      processingStatus: "syncing" as const,
      blocker: "syncing" as const,
      summary: "Resting Heart Rate baseline data is still syncing.",
      action: "Wait for the sync to finish, then check your baseline again.",
    },
    {
      processingStatus: "sync_error" as const,
      blocker: "sync_error" as const,
      summary: "Resting Heart Rate baseline data could not sync.",
      action: "Reconnect the data source and start the sync again.",
    },
  ])("surfaces the $processingStatus baseline processing state", (fixture) => {
    expect(
      buildHealthStatusFromSummary({
        metric: "resting_heart_rate",
        label: "Resting Heart Rate",
        value: null,
        baseline: null,
        sampleDeviation: null,
        intent: "lower",
        observedDays: 0,
        processingStatus: fixture.processingStatus,
      }),
    ).toMatchObject({
      baselineProgress: {
        blocker: fixture.blocker,
        summary: fixture.summary,
        action: fixture.action,
      },
    });
  });

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
        observedDays: 3,
        processingStatus: null,
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
        observedDays: 3,
        processingStatus: null,
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
        observedDays: 3,
        processingStatus: null,
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
        observedDays: 3,
        processingStatus: null,
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
  ])(
    "returns the exact evaluated rule at value $value",
    ({ value, statusToken, evaluationRule }) => {
      expect(
        buildHealthStatusFromSummary({
          metric: "skin_temperature",
          label: "Skin Temperature",
          value,
          baseline: 50,
          sampleDeviation: 10,
          intent: "neutral",
          observedDays: 3,
          processingStatus: null,
        }),
      ).toMatchObject({ statusToken, evaluationRule });
    },
  );

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
      observedDays: 3,
      processingStatus: null,
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
        observedDays: 3,
        processingStatus: null,
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
        processingStatus: null,
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

  it("uses the number of values for the default evidence window", () => {
    const result = buildHealthStatusFromValues({
      metric: "steps",
      label: "Steps",
      values: [70, 72, 74],
      intent: "neutral",
      observations: [
        { date: "2026-07-23", value: 70, sourceProviders: ["apple_health"] },
        { date: "2026-07-24", value: 72, sourceProviders: ["apple_health"] },
        { date: "2026-07-25", value: 74, sourceProviders: ["apple_health"] },
      ],
    });

    expect(result.provenance?.windowDays).toBe(3);
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
  ])(
    "classifies weight using $intent goal intent",
    ({ goalWeightKg, values, intent, statusToken }) => {
      expect(buildWeightHealthStatus(values, goalWeightKg)).toMatchObject({
        intent,
        statusToken,
      });
    },
  );
});
