import type { Meta, StoryObj } from "@storybook/react-vite";
import { DashboardEvidenceOverview } from "./DashboardEvidenceOverview";

const meta = {
  title: "Dashboard/DashboardEvidenceOverview",
  component: DashboardEvidenceOverview,
  tags: ["autodocs"],
  args: {
    days: 30,
    endDate: "2026-05-27",
    trend: { latestRestingHeartRate: 52, averageRestingHeartRate: 56 },
    healthMonitor: (
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-white/70 p-3">
          <p className="text-xs text-muted">Heart Rate Variability</p>
          <p className="mt-1 text-xl font-semibold text-foreground">68 ms</p>
        </div>
        <div className="rounded-lg border border-border bg-white/70 p-3">
          <p className="text-xs text-muted">Steps</p>
          <p className="mt-1 text-xl font-semibold text-foreground">7,640</p>
        </div>
        <div className="rounded-lg border border-border bg-white/70 p-3">
          <p className="text-xs text-muted">Active Energy</p>
          <p className="mt-1 text-xl font-semibold text-foreground">407 kcal</p>
        </div>
      </div>
    ),
    topInsight: {
      id: "insight-1",
      type: "correlation",
      confidence: "strong",
      metric: "Sleep consistency",
      action: "Heart Rate Variability",
      message: "Sleep consistency + Heart Rate Variability",
      detail: "30-day correlation",
      whenTrue: { mean: 1, n: 30 },
      whenFalse: { mean: 0, n: 30 },
      effectSize: 0.72,
      pValue: 0.01,
    },
  },
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-page p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DashboardEvidenceOverview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    topInsight: undefined,
    trend: { latestRestingHeartRate: undefined, averageRestingHeartRate: undefined },
    healthMonitor: (
      <div className="grid gap-3 sm:grid-cols-3" aria-busy="true">
        {[0, 1, 2].map((placeholder) => (
          <div
            key={placeholder}
            className="h-20 animate-pulse rounded-lg border border-border bg-white/70"
          />
        ))}
      </div>
    ),
  },
};

export const Empty: Story = {
  args: {
    topInsight: undefined,
    trend: { latestRestingHeartRate: null, averageRestingHeartRate: null },
    healthMonitor: <p className="text-sm text-muted">No recent health metrics yet.</p>,
  },
};
