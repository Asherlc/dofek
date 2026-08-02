import type { Meta, StoryObj } from "@storybook/react-native";
import { HealthStatusCards } from "./HealthStatusCards";

const readyBaselineProgress = {
  requiredObservationDays: 3,
  observedObservationDays: 3,
  hasMeasurableVariation: true,
  blocker: null,
  requirement: "A current value plus at least 2 more recorded days with measurable variation.",
  summary: "The baseline is ready.",
  action: "No action needed.",
} as const;

const collectingBaselineProgress = {
  requiredObservationDays: 3,
  observedObservationDays: 1,
  hasMeasurableVariation: false,
  blocker: "collecting" as const,
  requirement: "A current value plus at least 2 more recorded days with measurable variation.",
  summary: "The baseline is still collecting observations.",
  action: "Keep syncing data for at least 2 more days.",
};

const meta = {
  title: "Components/HealthStatusCards",
  component: HealthStatusCards,
  args: {
    metrics: [
      {
        metric: "trend_weight",
        label: "Trend Weight",
        value: 80,
        baseline: 82,
        sampleDeviation: 1,
        deviation: -2,
        direction: "below",
        intent: "lower",
        statusToken: "moving_as_intended",
        statusColor: "positive",
        statusLabel: "Moving as intended",
        evaluationRule: "Below your baseline, where lower values support this metric",
        explanation: "Trend Weight is below your baseline, in line with your weight goal.",
        baselineProgress: readyBaselineProgress,
      },
      {
        metric: "body_fat_percentage",
        label: "Body Fat %",
        value: 21.4,
        baseline: 20,
        sampleDeviation: 1,
        deviation: 1.4,
        direction: "above",
        intent: "neutral",
        statusToken: "notable_deviation",
        statusColor: "warning",
        statusLabel: "Notably above baseline",
        evaluationRule:
          "Outside your usual range: 1 to less than 2 standard deviations from baseline",
        explanation:
          "Body Fat % is above your usual range enough to stand out from recent variation.",
        baselineProgress: readyBaselineProgress,
      },
    ],
  },
} satisfies Meta<typeof HealthStatusCards>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Complete: Story = {};

export const InsufficientData: Story = {
  args: {
    metrics: [
      {
        metric: "trend_weight",
        label: "Trend Weight",
        value: null,
        baseline: null,
        sampleDeviation: null,
        deviation: null,
        direction: "unknown",
        intent: "neutral",
        statusToken: "insufficient_data",
        statusColor: "muted",
        statusLabel: "Not enough data",
        evaluationRule: "Needs a current value, baseline, and measurable day-to-day variation",
        explanation: "Not enough varied data yet to compare this value with your usual range.",
        baselineProgress: collectingBaselineProgress,
      },
    ],
  },
};

export const FarFromBaseline: Story = {
  args: {
    metrics: [
      {
        metric: "resting_heart_rate",
        label: "Resting Heart Rate",
        value: 68,
        baseline: 56,
        sampleDeviation: 5,
        deviation: 2.4,
        direction: "above",
        intent: "lower",
        statusToken: "far_from_baseline",
        statusColor: "danger",
        statusLabel: "Far above baseline",
        evaluationRule:
          "Well outside your usual range: at least 2 standard deviations from baseline",
        explanation:
          "Resting Heart Rate is well above your usual range compared with recent variation.",
        baselineProgress: readyBaselineProgress,
      },
    ],
  },
};
