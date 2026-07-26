import type { Meta, StoryObj } from "@storybook/react-native";
import { HealthStatusCards } from "./HealthStatusCards";

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
        explanation: "Trend Weight is below your baseline, in line with your weight goal.",
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
        explanation:
          "Body Fat % is above your usual range enough to stand out from recent variation.",
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
        explanation: "Not enough varied data yet to compare this value with your usual range.",
      },
    ],
  },
};
