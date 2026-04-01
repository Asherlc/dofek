import type { Meta, StoryObj } from "@storybook/react-vite";
import { CorrelationCard } from "./CorrelationCard";

const meta = {
  title: "Insights/CorrelationCard",
  component: CorrelationCard,
  tags: ["autodocs"],
  args: {
    insight: {
      id: "insight-1",
      type: "conditional",
      confidence: "strong",
      metric: "HRV",
      action: "Journal: Alcohol",
      message: "Your HRV is 15% lower on days after consuming alcohol.",
      detail: "Based on 42 days of data (p < 0.01).",
      whenTrue: { mean: 52, n: 12 },
      whenFalse: { mean: 61, n: 30 },
      effectSize: -0.45,
      pValue: 0.002,
      explanation: "Alcohol disrupts the autonomic nervous system and degrades sleep quality.",
      confounders: ["Late bedtime", "Dehydration"],
    },
  },
} satisfies Meta<typeof CorrelationCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ConditionalSuccess: Story = {};

export const EmergingSignal: Story = {
  args: {
    insight: {
      id: "insight-2",
      type: "correlation",
      confidence: "emerging",
      metric: "Deep Sleep",
      action: "Caffeine",
      message: "Higher caffeine intake correlates with less deep sleep.",
      detail: "Spearman rho = -0.32 (n=28).",
      whenTrue: { mean: 0, n: 28 }, // n is used for footer
      whenFalse: { mean: 0, n: 0 },
      effectSize: -0.32,
      pValue: 0.08,
      dataPoints: Array.from({ length: 20 }, (_, i) => ({
        x: Math.random() * 400,
        y: 120 - Math.random() * 60,
        date: `2026-03-${i + 1}`,
      })),
    },
  },
};

export const Discovery: Story = {
  args: {
    insight: {
      id: "insight-3",
      type: "conditional",
      confidence: "early",
      metric: "Ready Score",
      action: "Journal: Magnesium",
      message: "You tend to have higher readiness when you log Magnesium.",
      detail: "Early signal based on 10 entries.",
      whenTrue: { mean: 82, n: 4 },
      whenFalse: { mean: 75, n: 6 },
      effectSize: 0.25,
      pValue: 0.15,
    },
  },
};
