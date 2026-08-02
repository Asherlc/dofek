import type { ActivityOverviewComparison } from "@dofek/format/activity-overview";
import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-native";
import { ActivityOverview, type ActivityOverviewData } from "./ActivityOverview";

const metricUnits = new UnitConverter("metric");

const defaultComparison: ActivityOverviewComparison = {
  periodLabel: "previous 4 weeks",
  activityCount: { magnitude: 2, trend: "higher" },
  totalMinutes: { magnitude: 90, trend: "higher" },
  totalDistanceMeters: {
    magnitude: 1200,
    trend: "higher",
    state: { status: "available" },
  },
  totalElevationGainM: {
    magnitude: 0,
    trend: "unchanged",
    state: { status: "available" },
  },
};

const defaultOverview: ActivityOverviewData = {
  activityCount: 12,
  totalMinutes: 615,
  totalDistanceMeters: 42300,
  totalDistanceState: { status: "available" },
  totalElevationGainM: 520,
  totalElevationState: { status: "available" },
  comparison: defaultComparison,
};

const noDataOverview: ActivityOverviewData = {
  activityCount: 0,
  totalMinutes: 0,
  totalDistanceMeters: null,
  totalDistanceState: { status: "missing", reason: "Distance not recorded" },
  totalElevationGainM: null,
  totalElevationState: { status: "missing", reason: "Elevation gain not recorded" },
  comparison: {
    periodLabel: "previous 4 weeks",
    activityCount: { magnitude: 0, trend: "unchanged" },
    totalMinutes: { magnitude: 0, trend: "unchanged" },
    totalDistanceMeters: {
      magnitude: null,
      trend: "unavailable",
      state: { status: "missing", reason: "Distance not recorded" },
    },
    totalElevationGainM: {
      magnitude: null,
      trend: "unavailable",
      state: { status: "missing", reason: "Elevation gain not recorded" },
    },
  },
};

const meta = {
  title: "Activities/ActivityOverview",
  component: ActivityOverview,
  args: {
    overview: defaultOverview,
    units: metricUnits,
  },
} satisfies Meta<typeof ActivityOverview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    overview: undefined,
  },
};

export const NoData: Story = {
  args: {
    overview: noDataOverview,
  },
};

export const LowerComparison: Story = {
  args: {
    overview: {
      ...defaultOverview,
      comparison: {
        ...defaultComparison,
        activityCount: { magnitude: 2, trend: "lower" },
        totalMinutes: { magnitude: 90, trend: "lower" },
      },
    },
  },
};

export const UnavailableComparison: Story = {
  args: {
    overview: {
      ...defaultOverview,
      totalDistanceMeters: null,
      totalDistanceState: { status: "missing", reason: "Distance not recorded" },
      comparison: {
        ...defaultComparison,
        totalDistanceMeters: {
          magnitude: null,
          trend: "unavailable",
          state: { status: "missing", reason: "Previous period: Distance not recorded" },
        },
      },
    },
  },
};
