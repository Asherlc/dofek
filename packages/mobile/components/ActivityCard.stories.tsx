import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-native";
import { ActivityCard } from "./ActivityCard";

const metricUnits = new UnitConverter("metric");
const imperialUnits = new UnitConverter("imperial");

const meta = {
  title: "Components/ActivityCard",
  component: ActivityCard,
  args: {
    name: "Morning Run",
    activityType: "running",
    startedAt: "2026-03-31T08:00:00Z",
    endedAt: "2026-03-31T08:45:00Z",
    avgHr: 145,
    maxHr: 172,
    distanceKm: 8.5,
    calories: 620,
    units: metricUnits,
  },
} satisfies Meta<typeof ActivityCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const RunningMetric: Story = {};

export const RunningImperial: Story = {
  args: {
    units: imperialUnits,
  },
};

export const Cycling: Story = {
  args: {
    name: "Afternoon Ride",
    activityType: "cycling",
    avgPower: 210,
    distanceKm: 32.4,
    units: metricUnits,
  },
};

export const Strength: Story = {
  args: {
    name: "Upper Body Power",
    activityType: "strength_training",
    distanceKm: undefined,
    avgHr: 115,
    maxHr: 140,
    units: metricUnits,
  },
};

export const Minimal: Story = {
  args: {
    name: "",
    activityType: "yoga",
    distanceKm: undefined,
    calories: undefined,
    avgHr: undefined,
    maxHr: undefined,
    units: metricUnits,
  },
};
