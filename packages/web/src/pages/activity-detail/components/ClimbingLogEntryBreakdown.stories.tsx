import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useMemo, useState } from "react";
import { expect, waitFor, within } from "storybook/test";
import "leaflet/dist/leaflet.css";
import { ActivityRouteMap } from "../../../components/ActivityRouteMap.tsx";
import { ClimbingLogEntryBreakdown } from "./ClimbingLogEntryBreakdown.tsx";
import {
  areaClimbingLocation,
  climbingMapLocations,
  climbingMapLogs,
  exactClimbingLocation,
} from "./climbing-log-map-test-helpers.ts";
import { UnattachedClimbingLogEntries } from "./UnattachedClimbingLogEntries.tsx";

const NO_SENSOR_POINTS: { lat: number; lng: number }[] = [];
const SENSOR_POINTS = [
  { lat: 37.231, lng: -122.114 },
  { lat: 37.234, lng: -122.113 },
  { lat: 37.237, lng: -122.109 },
];
const SUGGESTED_LOGS = climbingMapLogs.slice(0, 2).map((entry, index) => ({
  ...entry,
  id: `suggestion-${index}`,
  externalId: `source-suggestion-${index}`,
  attempts: entry.attempts.map((attempt) => ({
    ...attempt,
    climbingLogEntryId: `suggestion-${index}`,
  })),
}));
const suggestionLocations = {
  "suggestion-0": exactClimbingLocation,
  "suggestion-1": areaClimbingLocation,
};
const meta = {
  title: "Climbing/Log Entry Breakdown",
  component: ClimbingLogEntryBreakdown,
  args: { entries: climbingMapLogs, locations: climbingMapLocations },
} satisfies Meta<typeof ClimbingLogEntryBreakdown>;
export default meta;
type Story = StoryObj<typeof meta>;
export const UnknownExecution: Story = {
  args: { entries: climbingMapLogs.slice(0, 1), locations: {} },
};
export const MixedGPS: Story = {};
export const ExactClimb: Story = { args: { entries: climbingMapLogs.slice(0, 1) } };
export const Area: Story = {
  args: {
    entries: climbingMapLogs.slice(1, 2).map((entry) => ({ ...entry, title: "Left Arete" })),
  },
};
export const LongName: Story = { args: { entries: climbingMapLogs.slice(1, 2) } };
export const Empty: Story = { args: { entries: [] } };
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
export const Wide: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 1000, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};

function ActivityArrangement({
  withRoute = false,
  suggestions = false,
  ...args
}: ComponentProps<typeof ClimbingLogEntryBreakdown> & {
  withRoute?: boolean;
  suggestions?: boolean;
}) {
  const [selectedEntryId, selectEntry] = useState<string | null>(null);
  const markers = useMemo(
    () =>
      args.entries.flatMap((entry, index) => {
        const location = args.locations?.[entry.id];
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
      }),
    [args.entries, args.locations],
  );
  return (
    <section className="space-y-4">
      <ActivityRouteMap
        points={withRoute ? SENSOR_POINTS : NO_SENSOR_POINTS}
        climbMarkers={markers}
        onSelectEntry={selectEntry}
      />
      <h3 className="text-sm font-medium">Climbs</h3>
      <ClimbingLogEntryBreakdown {...args} selectedEntryId={selectedEntryId} />
      {suggestions && (
        <UnattachedClimbingLogEntries
          suggestions={SUGGESTED_LOGS}
          locations={suggestionLocations}
          error={null}
          isLoading={false}
          state={{
            "suggestion-0": { pending: true, error: null },
            "suggestion-1": {
              pending: false,
              error: "Entry no longer available. Refresh and try again.",
            },
          }}
          onAttach={() => {}}
        />
      )}
    </section>
  );
}
export const RepeatedPoint: Story = {
  args: { entries: climbingMapLogs.filter((entry) => entry.id !== "tick-2") },
  render: (args) => <ActivityArrangement {...args} />,
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-entry-id="tick-4"]')).not.toBeNull(),
    );
    const dot = canvasElement.querySelector<SVGElement>('[data-entry-id="tick-4"]');
    if (!dot) throw new Error("Expected repeated source dot");
    const bounds = dot.getBoundingClientRect();
    // Preserve enumerable native coordinates for Leaflet's preclick event copy.
    dot.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: bounds.x + bounds.width / 2,
        clientY: bounds.y + bounds.height / 2,
      }),
    );
    await userEvent.click(await canvas.findByRole("button", { name: "Entry 1 · Swiss Cheese" }));
    await expect(
      canvas
        .getByRole("list", { name: "Attached climbing logs" })
        .querySelector('[aria-current="true"]'),
    ).toHaveTextContent("Entry 1 · Selected");
    canvas.getByRole("button", { name: "Entry 3 · Swiss Cheese" }).focus();
    await userEvent.keyboard("[Enter]");
    await expect(
      canvas
        .getByRole("list", { name: "Attached climbing logs" })
        .querySelector('[aria-current="true"]'),
    ).toHaveTextContent("Entry 3 · Selected");
    await expect(canvasElement.querySelector('[data-entry-id="tick-4"]')).toBe(dot);
  },
};
export const ActivityDetailClimbs: Story = {
  render: (args) => <ActivityArrangement {...args} withRoute suggestions />,
};
export const ActivityDetailPointsOnly: Story = {
  render: (args) => <ActivityArrangement {...args} />,
};
export const ActivityDetailNarrow: Story = {
  ...ActivityDetailClimbs,
  decorators: Narrow.decorators,
};
export const ActivityDetailWide: Story = { ...ActivityDetailClimbs, decorators: Wide.decorators };
