import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { fn } from "storybook/test";
import { CompletedActivityCard } from "./CompletedActivityCard";

const metricUnits = new UnitConverter("metric");

const sampleActivity = {
  id: "activity-1",
  name: "Morning ride",
  activityType: "road_cycling",
  primaryActivityType: null,
  modality: null,
  startedAt: "2026-11-24T15:08:00.000Z",
  endedAt: "2026-11-24T16:00:00.000Z",
  localTimeContext: {
    timezone: null,
    startUtcOffsetMinutes: -480,
    endUtcOffsetMinutes: -480,
    source: "provider_offset" as const,
  },
  durationMin: 52,
  source: {
    tree: { primary: null, otherSources: [] },
    origin: { status: "unresolved" as const, candidateMemberActivityIds: [] },
    primarySourceLabel: "Garmin Connect",
    sourceCount: 1,
    overlapSummary: null,
  },
  lastProcessedAt: "2026-11-24T16:05:00.000Z",
  distanceMeters: 18000,
  distanceState: { status: "available" as const },
  elevationGainM: 120,
  elevationState: { status: "available" as const },
  location: null,
  isProviderAbsent: true,
  stats: [],
};

const meta = {
  title: "Activities/CompletedActivityCard",
  component: CompletedActivityCard,
  decorators: [(Story) => <View style={{ width: 360, padding: 16 }}>{Story()}</View>],
  args: {
    activity: sampleActivity,
    units: metricUnits,
    selectMode: false,
    selected: false,
    showCompleted: true,
    onPress: fn(),
  },
} satisfies Meta<typeof CompletedActivityCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Completed: Story = {};

export const Selected: Story = {
  args: {
    selectMode: true,
    selected: true,
  },
};
