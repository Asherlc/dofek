import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { InsightEvidence } from "dofek-server/types";
import { DashboardEvidenceOverview } from "./DashboardEvidenceOverview";

function withRouter(Story: () => React.ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet });
  const storyRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Story });
  const heartRateRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/body/heart-rate",
    component: () => <p>Resting heart rate data</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([storyRoute, heartRateRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return <RouterProvider router={router} />;
}

const evidence: InsightEvidence = {
  relationship: "correlation",
  label: "Descriptive correlation",
  method: "Spearman rank correlation over paired observations with Benjamini–Hochberg screening.",
  interpretation:
    "This correlation does not prove cause. Missing data and other factors may affect it.",
  limitations: "No confidence interval is available for this correlation.",
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
      restingHeartRateTrendLabel: "below average",
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
  },
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    withRouter,
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
      restingHeartRateTrendLabel: "Waiting for baseline",
      restingHeartRatePoints: null,
    },
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
      restingHeartRateTrendLabel: "Waiting for baseline",
      restingHeartRatePoints: null,
    },
    healthMonitor: <p className="text-sm text-muted">No recent health metrics yet.</p>,
  },
};

export const BlockedBaseline: Story = {
  args: {
    trend: {
      latestRestingHeartRate: null,
      averageRestingHeartRate: null,
      restingHeartRateTrendLabel: "Waiting for baseline",
      restingHeartRateBaselineProgress: {
        requiredObservationDays: 3,
        observedObservationDays: 1,
        hasMeasurableVariation: false,
        blocker: "collecting",
        requirement:
          "A current value plus at least 2 more recorded days with measurable variation.",
        summary:
          "Resting Heart Rate has 1 of 3 required days recorded; the baseline is still collecting observations.",
        action: "Keep syncing resting heart rate data for at least 2 more days.",
      },
      restingHeartRatePoints: null,
    },
    healthMonitor: <p className="text-sm text-muted">Baseline evidence is collecting.</p>,
  },
};
