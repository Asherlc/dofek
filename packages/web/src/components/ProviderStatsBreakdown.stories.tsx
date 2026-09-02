import type { ProviderStats } from "@dofek/providers/provider-stats";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProviderStatsBreakdown } from "./ProviderStatsBreakdown.tsx";

const populatedStats = {
  totalRecords: 207_777,
  activities: 356,
  metricStream: 206_597,
  dailyMetrics: 230,
  sleepSessions: 155,
  bodyMeasurements: 43,
  healthEvents: 396,
  foodEntries: 0,
  nutritionDaily: 0,
  clinicalRecords: 0,
  journalEntries: 0,
} satisfies ProviderStats;

const zeroStats = {
  totalRecords: 0,
  activities: 0,
  metricStream: 0,
  dailyMetrics: 0,
  sleepSessions: 0,
  bodyMeasurements: 0,
  healthEvents: 0,
  foodEntries: 0,
  nutritionDaily: 0,
  clinicalRecords: 0,
  journalEntries: 0,
} satisfies ProviderStats;

const meta = {
  title: "Providers/ProviderStatsBreakdown",
  component: ProviderStatsBreakdown,
  args: {
    stats: populatedStats,
  },
  decorators: [
    (Story) => (
      <div className="w-screen max-w-sm p-6 bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProviderStatsBreakdown>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AllZero: Story = {
  args: { stats: zeroStats },
};

export const Full: Story = {
  args: { variant: "full" },
};
