import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { DataReadinessBanner, type DataReadinessSnapshot } from "./DataReadinessBanner";

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
      message: "Activities data is still being prepared. Please check back soon.",
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

const meta = {
  title: "State/DataReadinessBanner",
  component: DataReadinessBanner,
  decorators: [(Story) => <View style={{ width: 360, padding: 16 }}>{Story()}</View>],
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
  args: {
    data: {
      ...missingSnapshot,
      overallStatus: "syncing",
      syncingProviders: [{ id: "garmin", name: "Garmin" }],
    },
  },
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
