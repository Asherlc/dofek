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
    explanation: "Heart Rate Variability (HRV) is above your baseline.",
    ...overrides,
  };
}

const meta = {
  title: "Components/HealthStatusBar",
  component: HealthStatusBar,
  tags: ["autodocs"],
  args: {
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
        explanation: "Not enough varied data yet to compare this value with your usual range.",
      }),
    ],
  },
};
