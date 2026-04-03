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
    avgPower: null,
    distanceKm: 8.5,
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
    startedAt: "2026-03-31T14:00:00Z",
    endedAt: "2026-03-31T15:30:00Z",
    avgHr: 135,
    maxHr: 160,
    avgPower: 210,
    distanceKm: 32.4,
    units: metricUnits,
  },
};

export const Strength: Story = {
  args: {
    name: "Upper Body Power",
    activityType: "strength_training",
    startedAt: "2026-03-31T17:00:00Z",
    endedAt: "2026-03-31T18:00:00Z",
    avgHr: 115,
    maxHr: 140,
    avgPower: null,
    distanceKm: undefined,
    units: metricUnits,
  },
};

export const Minimal: Story = {
  args: {
    name: "",
    activityType: "yoga",
    startedAt: "2026-03-31T10:00:00Z",
    endedAt: null,
    avgHr: null,
    maxHr: null,
    avgPower: null,
    distanceKm: undefined,
    units: metricUnits,
  },
};
