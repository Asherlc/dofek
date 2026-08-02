import { formatHRVMeasurement } from "@dofek/format/format";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { HealthStatusMetric } from "../lib/healthStatus";
import { HealthStatusBar } from "./HealthStatusBar";

function hrvMetric(overrides: Partial<HealthStatusMetric> = {}): HealthStatusMetric {
  return {
    metric: "hrv",
    label: "Heart Rate Variability (HRV)",
    value: 65,
    baseline: 60,
    sampleDeviation: 8,
    deviation: 0.625,
    direction: "above",
    intent: "higher",
    statusToken: "moving_as_intended",
    statusColor: "positive",
    statusLabel: "Moving as intended",
    evaluationRule: "Above your baseline, where higher values support this metric",
    explanation: "Heart Rate Variability (HRV) is above your baseline.",
    baselineProgress: {
      requiredObservationDays: 3,
      observedObservationDays: 3,
      hasMeasurableVariation: true,
      blocker: null,
      requirement: "A current value plus at least 2 more recorded days with measurable variation.",
      summary: "Heart Rate Variability (HRV) baseline is ready.",
      action: "No action needed.",
    },
    ...overrides,
  };
}

const meta = {
  title: "Components/HealthStatusBar",
  component: HealthStatusBar,
  tags: ["autodocs"],
  args: {
    baselineRelative: [
      {
        metric: "hrv",
        label: "Heart Rate Variability (HRV)",
        value: 65,
        baseline: {
          windowDays: 30,
          mean: 60,
          standardDeviation: 8,
          zScore: 0.625,
          sampleCount: 27,
          coverage: 0.9,
        },
        comparison: {
          recentDays: 7,
          baselineDays: 28,
          recentMean: 64,
          baselineMean: 60,
          delta: 4,
          direction: "increasing",
        },
      },
    ],
    metrics: [hrvMetric()],
    formatters: { hrv: formatHRVMeasurement },
  },
} satisfies Meta<typeof HealthStatusBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Success: Story = {};

export const Warning: Story = {
  args: {
    metrics: [
      hrvMetric({
        value: 48,
        deviation: -1.5,
        direction: "below",
        statusToken: "notable_deviation",
        statusColor: "warning",
        statusLabel: "Notably below baseline",
        evaluationRule:
          "Outside your usual range: 1 to less than 2 standard deviations from baseline",
        explanation: "Heart Rate Variability (HRV) is below your usual range.",
      }),
    ],
  },
};

export const Destructive: Story = {
  args: {
    metrics: [
      hrvMetric({
        value: 38,
        deviation: -2.75,
        direction: "below",
        statusToken: "far_from_baseline",
        statusColor: "danger",
        statusLabel: "Far below baseline",
        evaluationRule:
          "Well outside your usual range: at least 2 standard deviations from baseline",
        explanation: "Heart Rate Variability (HRV) is well below your usual range.",
      }),
    ],
  },
};

export const Unknown: Story = {
  args: {
    metrics: [
      hrvMetric({
        value: null,
        deviation: null,
        direction: "unknown",
        statusToken: "insufficient_data",
        statusColor: "muted",
        statusLabel: "Not enough data",
        evaluationRule: "Needs a current value, baseline, and measurable day-to-day variation",
        explanation: "Not enough varied data yet to compare this value with your usual range.",
      }),
    ],
  },
};
