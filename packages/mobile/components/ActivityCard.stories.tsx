import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-native";
import { expect, within } from "storybook/test";
import { ActivityCard } from "./ActivityCard";

const metricUnits = new UnitConverter("metric");
const imperialUnits = new UnitConverter("imperial");

const meta = {
  title: "Components/ActivityCard",
  component: ActivityCard,
  args: {
    name: "Morning Run",
    activityType: "running",
    primaryActivityType: null,
    startedAt: "2026-03-31T08:00:00Z",
    durationMin: 45,
    avgHr: 145,
    maxHr: 172,
    avgPower: null,
    distanceKm: 8.5,
    distanceState: { status: "available" },
    units: metricUnits,
  },
} satisfies Meta<typeof ActivityCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const RunningMetric: Story = {};

export const PrimarySourceWithoutTitle: Story = {
  args: { name: null, activityType: "walking", primaryActivityType: "running" },
};

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
    durationMin: 90,
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
    activityType: "strength",
    startedAt: "2026-03-31T17:00:00Z",
    durationMin: 60,
    avgHr: 115,
    maxHr: 140,
    avgPower: null,
    distanceKm: null,
    distanceState: { status: "missing", reason: "Distance not recorded" },
    units: metricUnits,
  },
};

export const ClimbingUnknownDuration: Story = {
  args: {
    name: "Kilter climbing",
    activityType: "climbing",
    primaryActivityType: "climbing",
    startedAt: "2026-11-09T17:48:51.544-08:00",
    durationMin: null,
    avgHr: null,
    maxHr: null,
    avgPower: null,
    distanceKm: null,
    distanceState: { status: "missing", reason: "Distance not recorded" },
    units: metricUnits,
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/Duration unavailable/)).toBeVisible();
  },
};

export const Minimal: Story = {
  args: {
    name: null,
    activityType: "yoga",
    startedAt: "2026-03-31T10:00:00Z",
    durationMin: null,
    avgHr: null,
    maxHr: null,
    avgPower: null,
    distanceKm: null,
    distanceState: { status: "missing", reason: "Distance not recorded" },
    units: metricUnits,
  },
};
