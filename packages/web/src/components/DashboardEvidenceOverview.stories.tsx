import type { Meta, StoryObj } from "@storybook/react-vite";
import type { InsightEvidence } from "dofek-server/types";
import { DashboardEvidenceOverview } from "./DashboardEvidenceOverview";

const evidence: InsightEvidence = {
  relationship: "correlation",
  label: "Descriptive correlation",
  method: "Spearman rank correlation over paired observations with Benjamini–Hochberg screening.",
  interpretation:
    "This correlation describes co-movement in the observed data; it does not establish causation.",
  limitations:
    "The displayed n is the number of paired observations; missing observations and unmeasured confounders may affect this estimate. No confidence interval is available for this exploratory correlation.",
  recommendation: "Use this as a hypothesis, not a prescription or treatment recommendation.",
};

const meta = {
  title: "Dashboard/DashboardEvidenceOverview",
  component: DashboardEvidenceOverview,
  tags: ["autodocs"],
  args: {
    days: 90,
    endDate: "2026-05-27",
    trend: {
      latestRestingHeartRate: 52,
      averageRestingHeartRate: 56,
      restingHeartRatePoints: [
        { date: "2026-05-23", value: 57 },
        { date: "2026-05-24", value: 56 },
        { date: "2026-05-25", value: 55 },
        { date: "2026-05-26", value: 54 },
        { date: "2026-05-27", value: 52 },
      ],
    },
    healthMonitor: (
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-surface p-3">
          <p className="text-xs text-muted">Heart Rate Variability</p>
          <p className="mt-1 text-xl font-semibold text-foreground">68 ms</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <p className="text-xs text-muted">Steps</p>
          <p className="mt-1 text-xl font-semibold text-foreground">7,640</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <p className="text-xs text-muted">Respiratory Rate</p>
          <p className="mt-1 text-xl font-semibold text-foreground">14 breaths/min</p>
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
      evidence,
      dataPoints: [
        { x: 55, y: 65, date: "2026-05-23" },
        { x: 60, y: 70, date: "2026-05-24" },
        { x: 68, y: 82, date: "2026-05-25" },
        { x: 72, y: 85, date: "2026-05-26" },
        { x: 75, y: 88, date: "2026-05-27" },
      ],
    },
    trainingSleepPoints: [
      { date: "2026-05-23", trainingLoad: 42, sleepConsistency: 86 },
      { date: "2026-05-24", trainingLoad: 58, sleepConsistency: 78 },
      { date: "2026-05-25", trainingLoad: 66, sleepConsistency: 72 },
      { date: "2026-05-26", trainingLoad: 81, sleepConsistency: 67 },
      { date: "2026-05-27", trainingLoad: 94, sleepConsistency: 61 },
    ],
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
    trend: {
      latestRestingHeartRate: undefined,
      averageRestingHeartRate: undefined,
      restingHeartRatePoints: null,
    },
    trainingSleepPoints: null,
    healthMonitor: (
      <div className="grid gap-3 sm:grid-cols-3" aria-busy="true">
        {[0, 1, 2].map((placeholder) => (
          <div
            key={placeholder}
            className="h-20 animate-pulse rounded-lg border border-border bg-surface"
          />
        ))}
      </div>
    ),
  },
};

export const Empty: Story = {
  name: "Empty data",
  tags: ["review-scenario", "review-scenario-empty-data"],
  args: {
    topInsight: undefined,
    trend: {
      latestRestingHeartRate: null,
      averageRestingHeartRate: null,
      restingHeartRatePoints: null,
    },
    trainingSleepPoints: null,
    healthMonitor: <p className="text-sm text-muted">No recent health metrics yet.</p>,
  },
};
