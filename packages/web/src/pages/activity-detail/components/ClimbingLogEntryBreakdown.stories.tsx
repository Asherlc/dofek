import { climbingLogEntryName } from "@dofek/training/climbing-log";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useMemo, useState } from "react";
import { expect, within } from "storybook/test";
import "leaflet/dist/leaflet.css";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../../../server/src/repositories/climbing-test-helpers.ts";
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
    await expect(
      canvas.getByRole("link", { name: "Swiss Cheese on Mountain Project" }),
    ).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Left Arete on OpenBeta" })).toBeVisible();
  },
};
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grid = canvas.getByRole("region", { name: "Attached climbing logs" });
    const [first, second, third, fourth] = within(grid).getAllByRole("listitem");
    if (!first || !second || !third || !fourth) throw new Error("Expected four climbing logs");
    if (grid.getBoundingClientRect().width >= 900) {
      await expect(third.getBoundingClientRect().top).toBeCloseTo(
        first.getBoundingClientRect().top,
        0,
      );
      await expect(third.getBoundingClientRect().left).toBeGreaterThan(
        second.getBoundingClientRect().right,
      );
      await expect(fourth.getBoundingClientRect().top).toBeGreaterThan(
        first.getBoundingClientRect().bottom,
      );
    }
  },
};
export const SingleClimbWall: Story = {
  decorators: Wide.decorators,
  parameters: { layout: "padded" },
  args: {
    entries: [
      { wall: "Wreckage Wall", name: "Hunger Pains", grade: "5.10b" },
      { wall: "Memorial Wall", name: "Short Term Memory", grade: "5.10a" },
    ].map(({ wall, name, grade }, index) => {
      const climb = climbingClimbFixture();
      return climbingLogEntryFixture({
        id: `tick-${index + 1}`,
        displayGrade: grade,
        climb: {
          ...climb,
          name,
          areaPath: climb.areaPath.map((area) => ({ ...area, id: wall, name: wall })),
        },
      });
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grid = canvas.getByRole("region", { name: "Attached climbing logs" });
    const singleWall = canvas.getByRole("list", { name: "Wreckage Wall climbs" });
    const secondWall = canvas.getByRole("list", { name: "Memorial Wall climbs" });
    const singleClimb = within(singleWall).getByRole("listitem");
    const secondClimb = within(secondWall).getByRole("listitem");
    await expect(secondClimb.getBoundingClientRect().width).toBeCloseTo(
      singleClimb.getBoundingClientRect().width,
      0,
    );
    if (grid.getBoundingClientRect().width >= 600) {
      await expect(singleClimb.getBoundingClientRect().width).toBeLessThan(
        grid.getBoundingClientRect().width / 2,
      );
    } else if (grid.getBoundingClientRect().width <= 320) {
      await expect(singleClimb.getBoundingClientRect().width).toBeCloseTo(
        grid.getBoundingClientRect().width,
        0,
      );
      await expect(secondClimb.getBoundingClientRect().top).toBeGreaterThan(
        singleClimb.getBoundingClientRect().bottom,
      );
    }
    if (canvasElement.getBoundingClientRect().width >= 600) {
      await expect(secondClimb.getBoundingClientRect().top).toBeCloseTo(
        singleClimb.getBoundingClientRect().top,
        0,
      );
      await expect(secondClimb.getBoundingClientRect().left).toBeGreaterThan(
        singleClimb.getBoundingClientRect().right,
      );
    }
  },
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
                label: climbingLogEntryName(entry),
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
    const dot = await canvas.findByRole("button", {
      name: /^2 climbs · Swiss Cheese · Swiss Cheese ·/,
    });
    const bounds = dot.getBoundingClientRect();
    // Preserve enumerable native coordinates for Leaflet's preclick event copy.
    dot.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: bounds.x + bounds.width / 2,
        clientY: bounds.y + bounds.height / 2,
      }),
    );
    const [firstChoice, secondChoice] = await canvas.findAllByRole("button", {
      name: "Swiss Cheese",
    });
    if (!firstChoice || !secondChoice) throw new Error("Expected both climb choices");
    await userEvent.click(firstChoice);
    await expect(
      canvas
        .getByRole("region", { name: "Attached climbing logs" })
        .querySelector('[aria-current="true"]'),
    ).toBe(canvas.getByRole("list", { name: "Wall climbs" }).children[0]);
    secondChoice.focus();
    await userEvent.keyboard("[Enter]");
    await expect(
      canvas
        .getByRole("region", { name: "Attached climbing logs" })
        .querySelector('[aria-current="true"]'),
    ).toBe(canvas.getByRole("list", { name: "Wall climbs" }).children[1]);
    await expect(
      canvas.getByRole("button", { name: /^2 climbs · Swiss Cheese · Swiss Cheese ·/ }),
    ).toBe(dot);
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

export const KayaColors: Story = {
  args: {
    locations: {},
    entries: (["Flash", "Onsight", "sent"] as const).map((result, index) => {
      const id = `kaya-colored-${index}`;
      const color = ["Blue", "Yellow", "Purple"][index] ?? "Blue";
      const entry = climbingLogEntryFixture({
        id,
        providerId: "kaya",
        sourceName: "Kaya",
        title: null,
        climb: { ...climbingClimbFixture("kaya"), name: null, kind: "boulder", areaPath: [] },
        raw: { climb: { color: { name: color } } },
        displayGrade: "V5",
        recordedClimbOutcome: "completed",
        recordedClimbAttemptCount: result === "sent" ? 3 : 1,
      });
      entry.attempts = [
        climbingAttemptFixture(id, {
          rockResultLabels: result === "sent" ? ["sent"] : ["sent", result],
        }),
      ];
      return entry;
    }),
  },
};
