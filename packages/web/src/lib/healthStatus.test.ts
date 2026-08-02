import { describe, expect, it, vi } from "vitest";

describe("healthStatusMetricSchema", () => {
  it("accepts the complete server health-status contract", async () => {
    vi.resetModules();
    const { healthStatusMetricSchema } = await import("./healthStatus.ts");

    expect(
      healthStatusMetricSchema.parse({
        metric: "hrv",
        label: "Heart Rate Variability (HRV)",
        value: 52,
        baseline: 50,
        sampleDeviation: 2,
        deviation: 1,
        direction: "above",
        intent: "higher",
        statusToken: "moving_as_intended",
        statusColor: "positive",
        statusLabel: "Moving as intended",
        evaluationRule: "Above your baseline, where higher values support this metric",
        explanation: "Heart Rate Variability is above your baseline.",
        baselineProgress: {
          requiredObservationDays: 3,
          observedObservationDays: 3,
          hasMeasurableVariation: true,
          blocker: null,
          requirement:
            "A current value plus at least 2 more recorded days with measurable variation.",
          summary: "Heart Rate Variability baseline is ready.",
          action: "No action needed.",
        },
      }),
    ).toEqual({
      metric: "hrv",
      label: "Heart Rate Variability (HRV)",
      value: 52,
      baseline: 50,
      sampleDeviation: 2,
      deviation: 1,
      direction: "above",
      intent: "higher",
      statusToken: "moving_as_intended",
      statusColor: "positive",
      statusLabel: "Moving as intended",
      evaluationRule: "Above your baseline, where higher values support this metric",
      explanation: "Heart Rate Variability is above your baseline.",
      baselineProgress: {
        requiredObservationDays: 3,
        observedObservationDays: 3,
        hasMeasurableVariation: true,
        blocker: null,
        requirement:
          "A current value plus at least 2 more recorded days with measurable variation.",
        summary: "Heart Rate Variability baseline is ready.",
        action: "No action needed.",
      },
    });
  });

  it("rejects an object that omits the server health-status contract", async () => {
    vi.resetModules();
    const { healthStatusMetricSchema } = await import("./healthStatus.ts");

    expect(healthStatusMetricSchema.safeParse({}).success).toBe(false);
  });
});
