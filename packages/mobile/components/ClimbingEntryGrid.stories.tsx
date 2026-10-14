import type { ClimbingMapLocation, ClimbingMapMarker } from "@dofek/training/climbing-map";
import type { Meta, StoryObj } from "@storybook/react-native";
import { type ComponentProps, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { expect, fn, within } from "storybook/test";
import { colors } from "../theme";
import type { ClimbingCardEntry } from "./ClimbingEntryCard";
import { ClimbingEntryGrid } from "./ClimbingEntryGrid";
import {
  areaClimbingLocation,
  climbingEntryFixture,
  exactClimbingLocation,
} from "./climbing-entry-fixtures";
import { QueryStatePanel } from "./QueryStatePanel";
import { RouteMap } from "./RouteMap";

const NO_SENSOR_POINTS: { lat: number; lng: number }[] = [];

const entries = [
  climbingEntryFixture,
  {
    ...climbingEntryFixture,
    id: "tick-2",
    routeName: "Left Arete",
    grade: "5.8",
    sourceName: "OpenBeta",
    sourceLinks: [{ kind: "route", providerId: "openbeta", url: "https://openbeta.io/" }],
    context: { ...climbingEntryFixture.context, providerId: "openbeta" },
  },
  {
    ...climbingEntryFixture,
    id: "tick-3",
    routeName:
      "A very long route name across the upper wall above the California coastal climbing area",
    grade: "5.10a",
  },
  { ...climbingEntryFixture, id: "tick-4", routeName: "Swiss Cheese" },
] satisfies readonly ClimbingCardEntry[];
const locations: Readonly<Record<string, ClimbingMapLocation>> = {
  "tick-1": exactClimbingLocation,
  "tick-2": areaClimbingLocation,
  "tick-4": exactClimbingLocation,
};
const markers: ClimbingMapMarker[] = entries.flatMap((entry, index) => {
  const location = locations[entry.id];
  return location
    ? [{ entryId: entry.id, entryNumber: index + 1, label: entry.routeName, location }]
    : [];
});
const meta = {
  title: "Climbing/Entry Grid",
  component: ClimbingEntryGrid,
  args: { entries, locations },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ClimbingEntryGrid>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const MixedGps: Story = {};
export const NoGps: Story = { args: { locations: {} } };
export const RepeatedPoint: Story = {
  args: {
    entries: [
      entries[0] ?? climbingEntryFixture,
      entries[2] ?? climbingEntryFixture,
      entries[3] ?? climbingEntryFixture,
    ],
  },
  render: (args) => <RepeatedPointArrangement {...args} />,
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const overview = within(canvas.getByLabelText("Climbing location overview"));
    const dot = await overview.findByRole("button", { name: /^Entry 3 · Swiss Cheese, latitude/ });
    await userEvent.click(dot);
    await userEvent.click(canvas.getByRole("button", { name: "Entry 1 · Swiss Cheese" }));
    await expect(canvas.getByText("Entry 1 · Selected")).toBeVisible();
    const repeat = canvas.getByRole("button", { name: "Entry 3 · Swiss Cheese" });
    repeat.focus();
    await userEvent.keyboard("[Enter]");
    await expect(canvas.getByText("Entry 3 · Selected")).toBeVisible();
  },
};
function RepeatedPointArrangement(args: ComponentProps<typeof ClimbingEntryGrid>) {
  const [selectedEntryId, selectEntry] = useState<string | null>(null);
  const repeatMarkers = useMemo(
    () =>
      args.entries.flatMap((entry, index) => {
        const location = args.locations?.[entry.id];
        return location
          ? [
              {
                entryId: entry.id,
                entryNumber: index + 1,
                label: entry.routeName ?? "Climb",
                location,
              },
            ]
          : [];
      }),
    [args.entries, args.locations],
  );
  return (
    <View style={{ gap: 16 }}>
      <View accessibilityLabel="Climbing location overview">
        <RouteMap
          points={NO_SENSOR_POINTS}
          climbMarkers={repeatMarkers}
          onSelectEntry={selectEntry}
        />
      </View>
      <ClimbingEntryGrid {...args} selectedEntryId={selectedEntryId} />
    </View>
  );
}
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <View style={{ width: "100%", maxWidth: 320, padding: 16 }}>
        <View style={{ padding: 16 }}>
          <Story />
        </View>
      </View>
    ),
  ],
};
export const Wide: Story = {
  decorators: [
    (Story) => (
      <View style={{ width: 900, maxWidth: "100%" }}>
        <Story />
      </View>
    ),
  ],
};
export const AttachStates: Story = {
  args: {
    onAttach: fn(),
    attachmentStates: {
      "tick-1": { pending: true, error: null },
      "tick-2": {
        pending: false,
        error: "Refresh this activity and try attaching this entry again.",
      },
    },
  },
};
export const Loading: Story = {
  render: () => <QueryStatePanel variant="loading" minHeight={140} />,
};
export const Empty: Story = {
  args: { entries: [] },
  render: () => (
    <QueryStatePanel variant="empty" message="No unattached climbing entries for this day." />
  ),
};
export const ErrorState: Story = {
  render: () => (
    <QueryStatePanel
      variant="error"
      message="Climbing entries could not be loaded. Check your connection and retry."
      onRetry={fn()}
    />
  ),
};

function ActivityArrangement({ width, attach = false }: { width: number; attach?: boolean }) {
  const [selectedEntryId, selectEntry] = useState<string | null>(null);
  return (
    <View style={{ width: "100%", maxWidth: width, padding: 16, gap: 16 }}>
      <RouteMap points={NO_SENSOR_POINTS} climbMarkers={markers} onSelectEntry={selectEntry} />
      <View style={{ backgroundColor: colors.surface, padding: 16, borderRadius: 16, gap: 12 }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600" }}>Climbs</Text>
        <ClimbingEntryGrid
          entries={entries}
          locations={locations}
          selectedEntryId={selectedEntryId}
          onAttach={attach ? fn() : undefined}
          attachmentStates={
            attach
              ? {
                  "tick-1": { pending: true, error: null },
                  "tick-2": {
                    pending: false,
                    error: "Refresh this activity and try attaching this entry again.",
                  },
                }
              : undefined
          }
        />
      </View>
    </View>
  );
}
export const ActivityDetailNarrow: Story = { render: () => <ActivityArrangement width={375} /> };
export const ActivityDetailWide: Story = { render: () => <ActivityArrangement width={960} /> };
export const ActivityDetailAttachStates: Story = {
  render: () => <ActivityArrangement width={320} attach />,
};
