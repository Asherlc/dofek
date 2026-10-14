import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useMemo, useState } from "react";
import { expect, waitFor, within } from "storybook/test";
import "leaflet/dist/leaflet.css";
import type { ClimbingActivityEntryRow } from "../../../../../server/src/contracts/climbing-context-contracts.ts";
import { ActivityRouteMap } from "../../../components/ActivityRouteMap.tsx";
import { ClimbingEntryBreakdown } from "./ClimbingEntryBreakdown.tsx";
import { UnattachedClimbingEntries } from "./UnattachedClimbingEntries.tsx";

const NO_SENSOR_POINTS: { lat: number; lng: number }[] = [];
const SENSOR_POINTS = [
  { lat: 37.231, lng: -122.114 },
  { lat: 37.234, lng: -122.113 },
  { lat: 37.237, lng: -122.109 },
];

const entry: ClimbingActivityEntryRow = {
  id: "entry-1",
  climbType: "route",
  gradeSystem: "yds",
  grade: "5.10a",
  sent: false,
  attemptCount: null,
  attempts: [{ attemptIndex: 1, outcome: "failed", failureReason: "fell", notes: null }],
  ascentType: null,
  holdType: "crimp",
  routeName: "Corner",
  locationName: "Country > State > Region > Park > Crag > Wall",
  lead: false,
  sourceName: "Mountain Project",
  sourceLinks: [],
  wallAngleDegrees: null,
  context: {
    providerId: "mountain-project",
    locationPath: ["Country", "State", "Region", "Park", "Crag", "Wall"].map((name) => ({
      name,
      externalId: null,
      kind: null,
    })),
    board: null,
    wallAngle: null,
    climbStyle: "top-rope",
    resultStyle: "Fell/Hung",
  },
};

const meta = {
  title: "Activity Detail/ClimbingEntryBreakdown",
  component: ClimbingEntryBreakdown,
  args: { entries: [entry] },
} satisfies Meta<typeof ClimbingEntryBreakdown>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Outdoor: Story = {};
export const SwissCheese: Story = {
  args: {
    entries: [
      {
        ...entry,
        grade: "5.4",
        sent: null,
        attempts: [],
        holdType: null,
        routeName: "Swiss Cheese",
        sourceLinks: [
          {
            providerId: "mountain-project",
            kind: "route",
            url: "https://www.mountainproject.com/route/105734732/swiss-cheese",
          },
        ],
        locationName:
          "California > San Francisco Bay Area > South Bay Area > Castle Rock and Sanborn Area > Goat Rock Area > Goat Rock",
        context: {
          ...entry.context,
          locationPath: [
            "California",
            "San Francisco Bay Area",
            "South Bay Area",
            "Castle Rock and Sanborn Area",
            "Goat Rock Area",
            "Goat Rock",
          ].map((name) => ({
            name,
            externalId: null,
            kind: null,
          })),
          resultStyle: null,
        },
      },
    ],
  },
};
export const Onsight: Story = {
  args: {
    entries: [
      {
        ...entry,
        grade: "5.6",
        sent: true,
        attempts: [],
        ascentType: "Onsight",
        holdType: null,
        routeName: "Left Arete",
        lead: true,
        context: { ...entry.context, climbStyle: "lead", resultStyle: "Onsight" },
      },
    ],
  },
};
export const Flash: Story = {
  args: {
    entries: [
      {
        ...entry,
        sent: true,
        attemptCount: 1,
        attempts: [],
        ascentType: "Flash",
        holdType: null,
        context: { ...entry.context, resultStyle: "Flash" },
      },
    ],
  },
};
export const Board: Story = {
  args: {
    entries: [
      {
        ...entry,
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V4",
        sent: true,
        attemptCount: 2,
        ascentType: "Redpoint",
        lead: null,
        sourceName: "Kaya",
        sourceLinks: [],
        context: {
          ...entry.context,
          providerId: "kaya",
          board: { name: "Training Board", externalId: "board-1" },
          wallAngle: { value: -20, unit: null },
          climbStyle: null,
          resultStyle: "Redpoint",
        },
      },
    ],
  },
};

const gridEntries: ClimbingActivityEntryRow[] = [
  {
    ...entry,
    id: "tick-1",
    routeName: "Swiss Cheese",
    attempts: [],
    sourceLinks: [
      {
        providerId: "mountain-project",
        kind: "route",
        url: "https://www.mountainproject.com/route/105734732/swiss-cheese",
      },
    ],
  },
  {
    ...entry,
    id: "tick-2",
    routeName:
      "The unusually long ridge traverse above the north-facing wall and its narrow exposed corner",
    attempts: [],
    sourceName: "OpenBeta",
    context: { ...entry.context, providerId: "openbeta" },
    sourceLinks: [{ providerId: "openbeta", kind: "route", url: "https://openbeta.io/" }],
  },
  { ...entry, id: "tick-3", routeName: "Swiss Cheese", attempts: [] },
  {
    ...entry,
    id: "tick-4",
    routeName: "Indoor board tick",
    attempts: [],
    context: {
      ...entry.context,
      locationPath: [],
      board: { name: "Training Board", externalId: null },
    },
  },
];
const exactLocation: ClimbingMapLocation = {
  coordinates: { latitude: 37.234, longitude: -122.111 },
  scope: "climb",
  objectId: "swiss-cheese",
  providerId: "mountain-project",
  name: "Swiss Cheese",
};
const areaLocation: ClimbingMapLocation = {
  coordinates: { latitude: 37.236, longitude: -122.112 },
  scope: "area",
  objectId: "goat-rock",
  providerId: "openbeta",
  name: "Goat Rock",
};
const locations: Record<string, ClimbingMapLocation> = {
  "tick-1": exactLocation,
  "tick-2": areaLocation,
  "tick-3": exactLocation,
};
export const MixedGPS: Story = { args: { entries: gridEntries, locations } };
export const ExactClimb: Story = { args: { entries: gridEntries.slice(0, 1), locations } };
export const Area: Story = { args: { entries: gridEntries.slice(1, 2), locations } };
export const LongName: Story = { ...Area };
export const RepeatedPoint: Story = {
  args: {
    entries: [gridEntries[0] ?? entry, gridEntries[3] ?? entry, gridEntries[2] ?? entry],
    locations,
  },
  render: (args) => <RepeatedPointArrangement {...args} />,
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-entry-id="tick-3"]')).not.toBeNull(),
    );
    const dot = canvasElement.querySelector<SVGElement>('[data-entry-id="tick-3"]');
    if (!dot) throw new Error("Expected repeated source dot");
    const bounds = dot.getBoundingClientRect();
    // Leaflet copies enumerable MouseEvent coordinates for its synthetic preclick;
    // user-event shadows those coordinates with nonenumerable properties.
    dot.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: bounds.x + bounds.width / 2,
        clientY: bounds.y + bounds.height / 2,
      }),
    );
    await userEvent.click(await canvas.findByRole("button", { name: "Entry 1 · Swiss Cheese" }));
    await expect(
      canvas.getAllByRole("listitem").find((card) => card.getAttribute("aria-current") === "true"),
    ).toHaveTextContent("Entry 1 · Selected");
    const repeat = canvas.getByRole("button", { name: "Entry 3 · Swiss Cheese" });
    repeat.focus();
    await userEvent.keyboard("[Enter]");
    await expect(
      canvas.getAllByRole("listitem").find((card) => card.getAttribute("aria-current") === "true"),
    ).toHaveTextContent("Entry 3 · Selected");
    await expect(canvasElement.querySelector('[data-entry-id="tick-3"]')).toBe(dot);
  },
};
function RepeatedPointArrangement(args: ComponentProps<typeof ClimbingEntryBreakdown>) {
  const [selectedEntryId, selectEntry] = useState<string | null>(null);
  const markers = useMemo(
    () =>
      args.entries.flatMap((tick, index) => {
        const location = args.locations?.[tick.id];
        return location
          ? [
              {
                entryId: tick.id,
                entryNumber: index + 1,
                label: tick.routeName ?? "Climb",
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
        points={NO_SENSOR_POINTS}
        climbMarkers={markers}
        onSelectEntry={selectEntry}
      />
      <ClimbingEntryBreakdown {...args} selectedEntryId={selectedEntryId} />
    </section>
  );
}
export const Empty: Story = { args: { entries: [] } };
export const Narrow: Story = {
  ...MixedGPS,
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
export const Wide: Story = {
  ...MixedGPS,
  decorators: [
    (Story) => (
      <div style={{ width: 1000, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
export const ActivityDetailClimbs: Story = {
  ...MixedGPS,
  render: (args) => <ActivityDetailArrangement {...args} />,
};
function ActivityDetailArrangement(args: ComponentProps<typeof ClimbingEntryBreakdown>) {
  const [selectedEntryId, selectEntry] = useState<string | null>(null);
  const markers = useMemo(
    () =>
      args.entries.flatMap((tick, index) => {
        const location = args.locations?.[tick.id];
        return location
          ? [
              {
                entryId: tick.id,
                entryNumber: index + 1,
                label: tick.routeName ?? "Climb",
                location,
              },
            ]
          : [];
      }),
    [args.entries, args.locations],
  );
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Climbing activity</h2>
      <ActivityRouteMap points={SENSOR_POINTS} climbMarkers={markers} onSelectEntry={selectEntry} />
      <h3 className="text-sm font-medium">Climbs</h3>
      <ClimbingEntryBreakdown {...args} selectedEntryId={selectedEntryId} />
      <UnattachedClimbingEntries
        suggestions={gridEntries.slice(0, 2).map((tick, index) => ({
          ...tick,
          id: `suggestion-${index}`,
          providerId: tick.context.providerId,
        }))}
        locations={{ "suggestion-0": exactLocation, "suggestion-1": areaLocation }}
        error={null}
        isLoading={false}
        state={{
          "suggestion-0": { pending: true, error: null },
          "suggestion-1": {
            pending: false,
            error: "Entry no longer available. Refresh and try again.",
          },
        }}
        onAttach={() => undefined}
      />
    </section>
  );
}
export const ActivityDetailNarrow: Story = {
  ...ActivityDetailClimbs,
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
export const ActivityDetailWide: Story = {
  ...ActivityDetailClimbs,
  decorators: [
    (Story) => (
      <div style={{ width: 1000, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
export const ActivityDetailPointsOnly: Story = {
  ...MixedGPS,
  render: (args) => <RepeatedPointArrangement {...args} />,
};
