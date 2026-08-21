import type { Meta, StoryObj } from "@storybook/react-vite";
import type { HealthspanResult } from "dofek-server/types";
import { HealthspanScoreCard } from "./HealthspanScoreCard.tsx";

const data: HealthspanResult = {
  healthspanScore: 78,
  yearsDelta: -2.1,
  trend: "improving",
  availability: {
    status: "available",
    availableMetricCount: 5,
    requiredMetricCount: 3,
    missingMetricLabels: [
      "Aerobic Activity",
      "High Intensity",
      "Strength Training",
      "Lean Body Mass",
    ],
    summary: "5 supported Healthspan metrics are available; 3 are required for a score.",
    nextCondition: null,
  },
  history: [
    { weekStart: "2026-03-02", score: 73 },
    { weekStart: "2026-03-09", score: 75 },
    { weekStart: "2026-03-16", score: 78 },
    { weekStart: "2026-03-23", score: 80 },
  ],
  metrics: [
    {
      name: "Resting Heart Rate",
      value: 56,
      unit: "bpm",
      score: 88,
      status: "excellent",
      yearsDelta: -1.4,
    },
    { name: "HRV", value: 48, unit: "ms", score: 74, status: "good", yearsDelta: -0.8 },
    { name: "VO2 Max", value: 43, unit: "ml/kg/min", score: 79, status: "good", yearsDelta: -1 },
    {
      name: "Daily Steps",
      value: 9800,
      unit: "steps",
      score: 82,
      status: "good",
      yearsDelta: -1.1,
    },
    {
      name: "Sleep Duration",
      value: 7.3,
      unit: "hours",
      score: 71,
      status: "good",
      yearsDelta: -0.6,
    },
  ],
};

const meta = {
  title: "Health/HealthspanScoreCard",
  component: HealthspanScoreCard,
  tags: ["autodocs"],
  args: {
    data,
  },
  decorators: [
    (Story) => (
      <div className="w-[680px] bg-page p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HealthspanScoreCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Declining: Story = {
  args: {
    data: {
      ...data,
      healthspanScore: 46,
      yearsDelta: 3.2,
      trend: "declining",
      metrics: data.metrics.map((metric) => ({
        ...metric,
        score: Math.max(25, metric.score - 35),
        status: "poor",
        yearsDelta: Math.abs(metric.yearsDelta),
      })),
    },
  },
};

export const Loading: Story = {
  args: {
    data: undefined,
    loading: true,
  },
};

export const InsufficientData: Story = {
  args: {
    data: {
      healthspanScore: null,
      yearsDelta: null,
      metrics: [],
      history: [],
      trend: null,
      availability: {
        status: "insufficient_data",
        availableMetricCount: 2,
        requiredMetricCount: 3,
        missingMetricLabels: ["VO2 Max", "Daily Steps"],
        summary: "2 of 3 required Healthspan metrics are available.",
        nextCondition:
          "The score becomes available after 1 more supported metric syncs successfully.",
      },
    },
  },
};
