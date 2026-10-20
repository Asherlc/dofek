import type { ClimbingMapLocation, ClimbingMapMarker } from "@dofek/training/climbing-map";
import type { Meta, StoryObj } from "@storybook/react-native";
import { type ComponentProps, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { expect, fn, within } from "storybook/test";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../server/src/repositories/climbing-test-helpers.ts";
import { colors } from "../theme";
import { ClimbingLogEntryBreakdown } from "./ClimbingLogEntryBreakdown";
import {
  areaClimbingLocation,
  climbingLogFixture,
  exactClimbingLocation,
} from "./climbing-log-entry-fixtures";
import { QueryStatePanel } from "./QueryStatePanel";
import { RouteMap } from "./RouteMap";

const NO_SENSOR_POINTS: { lat: number; lng: number }[] = [];

const entries = [
  climbingLogFixture,
  {
    ...climbingLogFixture,
    id: "tick-2",
    providerId: "openbeta",
    climb: { ...climbingClimbFixture("openbeta"), name: "Left Arete" },
    displayGrade: "5.8",
    sourceName: "OpenBeta",
    sourceLinks: [{ kind: "route", providerId: "openbeta", url: "https://openbeta.io/" }],
  },
  {
    ...climbingLogFixture,
    id: "tick-3",
    climb: null,
    title:
      "A very long route name across the upper wall above the California coastal climbing area",
    displayGrade: "5.10a",
  },
  { ...climbingLogFixture, id: "tick-4" },
] satisfies readonly ClimbingLogEntryDetail[];
const locations: Readonly<Record<string, ClimbingMapLocation>> = {
  "tick-1": exactClimbingLocation,
  "tick-2": areaClimbingLocation,
  "tick-4": exactClimbingLocation,
};
function markersForEntries(
  entries: readonly ClimbingLogEntryDetail[],
  locations: Readonly<Record<string, ClimbingMapLocation>> | undefined,
): ClimbingMapMarker[] {
  return entries.flatMap((entry, index) => {
    const location = locations?.[entry.id];
    return location
      ? [
          {
            entryId: entry.id,
            entryNumber: index + 1,
            label: entry.climb?.name ?? entry.title ?? "Climbing log",
            location,
          },
        ]
      : [];
  });
}
const markers = markersForEntries(entries, locations);
const meta = {
  title: "Climbing/Log Entry Breakdown",
  component: ClimbingLogEntryBreakdown,
  args: { entries, locations },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ClimbingLogEntryBreakdown>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const MixedGps: Story = {};
export const NoGps: Story = { args: { locations: {} } };
export const OverlappingSources: Story = {
  args: {
    locations: {},
    entries: ["mountain-project", "openbeta"].map((providerId, index) => {
      const id = `30000000-0000-4000-8000-00000000000${index + 1}`;
      const areaId = `40000000-0000-4000-8000-00000000000${index + 1}`;
      const regionId = `50000000-0000-4000-8000-00000000000${index + 1}`;
      const climb = climbingClimbFixture(providerId);
      climb.id = `60000000-0000-4000-8000-00000000000${index + 1}`;
      climb.name = index === 0 ? "Swiss Cheese" : "Left Arete";
      climb.areaId = areaId;
      climb.areaPath = climb.areaPath.flatMap((area) => [
        { ...area, id: regionId, name: "Donner Summit", parentAreaId: null },
        { ...area, id: areaId, name: "Green Phantom Rock", parentAreaId: regionId },
      ]);
      return climbingLogEntryFixture({
        id,
        providerId,
        sourceName: index === 0 ? "Mountain Project" : "OpenBeta",
        climb,
        climbId: climb.id,
        displayGrade: index === 0 ? "5.4" : "5.8",
        recordedClimbAttemptCount: providerId === "mountain-project" ? null : 1,
        attempts: [climbingAttemptFixture(id, { ropeMethod: "lead" })],
        sourceLinks: [
          {
            providerId,
            kind: "route",
            url:
              index === 0
                ? "https://www.mountainproject.com/route/105734732/swiss-cheese"
                : "https://openbeta.io/climb/10000000-0000-4000-8000-000000000001",
          },
        ],
      });
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("heading", { name: "Green Phantom Rock" })).toHaveLength(1);
    await expect(canvas.getByLabelText("Swiss Cheese on Mountain Project")).toBeVisible();
    await expect(canvas.getByLabelText("Left Arete on OpenBeta")).toBeVisible();
  },
};
export const RepeatedPoint: Story = {
  args: {
    entries: [
      entries[0] ?? climbingLogFixture,
      entries[2] ?? climbingLogFixture,
      entries[3] ?? climbingLogFixture,
    ],
  },
  render: (args) => <RepeatedPointArrangement {...args} />,
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const overview = within(canvas.getByLabelText("Climbing location overview"));
    const dot = await overview.findByRole("button", {
      name: /^2 climbs · Swiss Cheese · Swiss Cheese, latitude/,
    });
    await userEvent.click(dot);
    const [firstChoice, repeat] = await canvas.findAllByRole("button", { name: "Swiss Cheese" });
    if (!firstChoice || !repeat) throw new Error("Expected both climb choices");
    const [firstCard, repeatedCard] = canvas.getAllByLabelText("Climbing entry: Swiss Cheese");
    if (!firstCard || !repeatedCard) throw new Error("Expected both climbing cards");
    await userEvent.click(firstChoice);
    await expect(firstCard).toHaveStyle({ borderColor: colors.accent, borderWidth: "1px" });
    repeat.focus();
    await userEvent.keyboard("[Enter]");
    await expect(repeatedCard).toHaveStyle({ borderColor: colors.accent, borderWidth: "1px" });
  },
};
function RepeatedPointArrangement(args: ComponentProps<typeof ClimbingLogEntryBreakdown>) {
  const [selectedEntryId, selectEntry] = useState<string | null>(null);
  const repeatMarkers = useMemo(
    () => markersForEntries(args.entries, args.locations),
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
      <ClimbingLogEntryBreakdown {...args} selectedEntryId={selectedEntryId} />
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pending = canvas.getByRole("button", {
      name: "Attach entry 1, Swiss Cheese to this activity",
    });
    const repeat = canvas.getByRole("button", {
      name: "Attach entry 4, Swiss Cheese to this activity",
    });
    await expect(pending).toHaveAttribute("aria-busy", "true");
    await expect(pending).toHaveAttribute("aria-disabled", "true");
    await expect(repeat).toHaveAttribute("aria-busy", "false");
    await expect(repeat).toHaveAttribute("aria-disabled", "false");
  },
};
export const Loading: Story = {
  render: () => <QueryStatePanel variant="loading" minHeight={140} />,
};
export const Empty: Story = {
  args: { entries: [] },
  render: () => (
    <QueryStatePanel variant="empty" message="No unattached climbing logs for this day." />
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
        <ClimbingLogEntryBreakdown
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

const unknownLog = climbingLogEntryFixture({
  climb: climbingClimbFixture(),
  displayGrade: "5.10a",
  recordedClimbAttemptCount: 1,
});
unknownLog.attempts = [climbingAttemptFixture(unknownLog.id, { ropeMethod: "top_rope" })];
export const UnknownExecution: Story = { args: { entries: [unknownLog], locations: {} } };
