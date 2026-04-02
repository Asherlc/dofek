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
      dataPoints: [
        { x: 20, y: 115, date: "2026-03-01" },
        { x: 40, y: 118, date: "2026-03-02" },
        { x: 60, y: 112, date: "2026-03-03" },
        { x: 80, y: 110, date: "2026-03-04" },
        { x: 100, y: 108, date: "2026-03-05" },
        { x: 120, y: 106, date: "2026-03-06" },
        { x: 140, y: 104, date: "2026-03-07" },
        { x: 160, y: 102, date: "2026-03-08" },
        { x: 180, y: 100, date: "2026-03-09" },
        { x: 200, y: 98, date: "2026-03-10" },
        { x: 220, y: 96, date: "2026-03-11" },
        { x: 240, y: 94, date: "2026-03-12" },
        { x: 260, y: 92, date: "2026-03-13" },
        { x: 280, y: 90, date: "2026-03-14" },
        { x: 300, y: 88, date: "2026-03-15" },
        { x: 320, y: 86, date: "2026-03-16" },
        { x: 340, y: 84, date: "2026-03-17" },
        { x: 360, y: 82, date: "2026-03-18" },
        { x: 380, y: 80, date: "2026-03-19" },
        { x: 400, y: 78, date: "2026-03-20" },
      ],
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
