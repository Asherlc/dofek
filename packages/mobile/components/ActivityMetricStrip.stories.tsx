import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-native";
import { ActivityMetricStrip } from "./ActivityMetricStrip";

const metricUnits = new UnitConverter("metric");

const meta = {
  title: "Components/ActivityMetricStrip",
  component: ActivityMetricStrip,
  args: {
    activity: {
      location: { mapPreview: {} },
      distanceMeters: 8500,
      distanceState: { status: "available" },
      elevationGainM: 120,
      elevationState: { status: "available" },
      stats: [],
    },
    units: metricUnits,
  },
} satisfies Meta<typeof ActivityMetricStrip>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AvailableRouteMetrics: Story = {};

export const UnavailableRouteMetrics: Story = {
  args: {
    activity: {
      location: { mapPreview: {} },
      distanceMeters: null,
      distanceState: { status: "missing", reason: "Distance was not recorded." },
      elevationGainM: null,
      elevationState: { status: "missing", reason: "Elevation was not recorded." },
      stats: [],
    },
  },
};

export const Empty: Story = {
  args: {
    activity: {
      location: null,
      distanceMeters: null,
      distanceState: { status: "missing", reason: "Distance is not applicable." },
      elevationGainM: null,
      elevationState: { status: "missing", reason: "Elevation is not applicable." },
      stats: [],
    },
  },
};

export const ActivityStats: Story = {
  args: {
    activity: {
      location: null,
      distanceMeters: null,
      distanceState: { status: "missing", reason: "Distance is not applicable." },
      elevationGainM: null,
      elevationState: { status: "missing", reason: "Elevation is not applicable." },
      stats: [
        { status: "available", label: "Training Stress Score", value: "100" },
        { status: "missing", label: "Average Power", reason: "Power was not recorded." },
      ],
    },
  },
};
