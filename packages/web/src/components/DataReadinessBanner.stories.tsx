import type { Meta, StoryObj } from "@storybook/react-vite";
import { DataReadinessBanner, type DataReadinessSnapshot } from "./DataReadinessBanner.tsx";

const staleSnapshot: DataReadinessSnapshot = {
  overallStatus: "stale",
  generatedAt: "2026-06-30T08:00:00.000Z",
  datasets: [
    {
      key: "dailyMetrics",
      label: "Daily metrics",
      rawRows: 42,
      latestRawAt: "2026-06-30T07:00:00.000Z",
      latestReadModelAt: "2026-06-30T05:00:00.000Z",
      cdcLagSeconds: 7200,
      readModelLagSeconds: 7200,
      status: "stale",
      message: "Daily metrics data is synced, but dashboard summaries are still catching up.",
    },
    {
      key: "activity",
      label: "Activities",
      rawRows: 12,
      latestRawAt: "2026-06-30T07:00:00.000Z",
      latestReadModelAt: "2026-06-30T07:00:00.000Z",
      cdcLagSeconds: 0,
      readModelLagSeconds: 0,
      status: "healthy",
      message: "Activities summaries are current.",
    },
  ],
};

const blockedSnapshot: DataReadinessSnapshot = {
  ...staleSnapshot,
  overallStatus: "blocked",
  datasets: [
    {
      key: "activity",
      label: "Activities",
      rawRows: 12,
      latestRawAt: "2026-06-30T07:00:00.000Z",
      latestReadModelAt: null,
      cdcLagSeconds: null,
      readModelLagSeconds: null,
      status: "blocked",
      message: "Activities data is available, but ClickHouse mirrors are not current.",
    },
  ],
};

const missingSnapshot: DataReadinessSnapshot = {
  ...staleSnapshot,
  overallStatus: "missing",
  datasets: [
    {
      key: "sleep",
      label: "Sleep",
      rawRows: 0,
      latestRawAt: null,
      latestReadModelAt: null,
      cdcLagSeconds: null,
      readModelLagSeconds: null,
      status: "missing",
      message: "No sleep data has been synced yet.",
    },
  ],
};

const syncingSnapshot: DataReadinessSnapshot = {
  ...missingSnapshot,
  overallStatus: "syncing",
  syncingProviders: [{ id: "garmin", name: "Garmin" }],
};

const meta = {
  title: "State/DataReadinessBanner",
  component: DataReadinessBanner,
  decorators: [(Story) => <div className="w-[760px] p-4">{Story()}</div>],
  args: {
    data: staleSnapshot,
  },
} satisfies Meta<typeof DataReadinessBanner>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Stale: Story = {};

export const Blocked: Story = {
  args: { data: blockedSnapshot },
};

export const Missing: Story = {
  args: { data: missingSnapshot },
};

export const Syncing: Story = {
  args: { data: syncingSnapshot },
};

export const MultipleAlerts: Story = {
  args: {
    data: {
      ...blockedSnapshot,
      datasets: [
        ...staleSnapshot.datasets,
        ...missingSnapshot.datasets,
        ...blockedSnapshot.datasets,
      ],
    },
  },
};

export const StackedPageContent: Story = {
  args: { data: syncingSnapshot },
  render: (args) => (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold text-foreground">Last 4 weeks</h2>
      <DataReadinessBanner {...args} />
      <div className="h-36 rounded-lg border border-border bg-surface" aria-hidden="true" />
    </section>
  ),
};

export const HealthyHidden: Story = {
  args: { data: { ...staleSnapshot, overallStatus: "healthy", datasets: [] } },
};

export const LoadingHidden: Story = {
  args: { loading: true },
};

export const QueryError: Story = {
  args: { error: new Error("ClickHouse read model query failed") },
};
