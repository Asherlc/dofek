import type { Meta, StoryObj } from "@storybook/react-vite";
import { AnomalyAlertBanner } from "./AnomalyAlertBanner.tsx";

const alertAnomaly = {
  date: "2026-04-26",
  metric: "Heart Rate Variability",
  value: 26.3,
  baselineMean: 60.2,
  baselineStddev: 10.5,
  zScore: -3.24,
  severity: "alert",
} as const;

const warningAnomaly = {
  date: "2026-04-26",
  metric: "Sleep Duration",
  value: 325,
  baselineMean: 440,
  baselineStddev: 42,
  zScore: -2.74,
  severity: "warning",
} as const;

const meta = {
  title: "Dashboard/AnomalyAlertBanner",
  component: AnomalyAlertBanner,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="max-w-3xl p-6">
        <Story />
      </div>
    ),
  ],
  args: {
    anomalies: [alertAnomaly],
  },
} satisfies Meta<typeof AnomalyAlertBanner>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Warning: Story = {
  args: {
    anomalies: [warningAnomaly],
  },
};

export const IllnessPattern: Story = {
  args: {
    anomalies: [
      {
        ...alertAnomaly,
        metric: "Resting Heart Rate",
        value: 73,
        baselineMean: 54,
        baselineStddev: 5,
        zScore: 3.8,
      },
      alertAnomaly,
    ],
  },
};

export const Loading: Story = {
  args: {
    loading: true,
  },
};

export const Empty: Story = {
  args: {
    anomalies: [],
  },
};
