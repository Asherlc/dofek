import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";
import "maplibre-gl/dist/maplibre-gl.css";
import { ActivityClimbingPanel } from "./ActivityClimbingPanel.tsx";
import { MetricsChart } from "./ActivityDetailCharts.tsx";
import {
  climbingMapLocations,
  climbingMapLogs,
  exactClimbingLocation,
} from "./climbing-log-map-test-helpers.ts";

// Retain the complete contract from existing fixtures while naming the second area.
const first = climbingMapLogs[0];
if (!first?.climb) throw new Error("Expected climbing fixture");
const firstClimb = first.climb;
const storyEntries = climbingMapLogs.map((entry, index) => ({
  ...entry,
  title: index === 1 ? "Left Arete" : entry.title,
  climb:
    index === 2
      ? entry.climb
      : {
          ...(entry.climb ?? firstClimb),
          name: index === 1 ? "Left Arete" : (entry.climb?.name ?? null),
          areaPath: firstClimb.areaPath.map((area) => ({
            ...area,
            id: index === 1 ? "north-wall" : area.id,
            name: index === 1 ? "North Wall" : "Goat Rock",
          })),
        },
}));
const meta = {
  title: "Activity/Climbing layout",
  component: ActivityClimbingPanel,
  parameters: { layout: "padded" },
  args: { entries: storyEntries, locations: climbingMapLocations, onOpenEntry: fn() },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-6xl rounded-xl border border-border bg-surface p-4">
        <h2 className="mb-4 text-lg font-semibold">Climbs</h2>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActivityClimbingPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const GroupedListAndMap: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const dot = await canvas.findByRole(
      "button",
      { name: /^2 climbs · Swiss Cheese/ },
      { timeout: 30000 },
    );
    const firstRow = canvas.getByRole("button", { name: "Select entry 1, Swiss Cheese" });
    await userEvent.hover(firstRow);
    await waitFor(() => expect(dot).toHaveAttribute("data-highlighted", "true"));
    await userEvent.hover(canvas.getByRole("heading", { name: "Climbs", level: 2 }));
    firstRow.focus();
    await waitFor(() => expect(dot).toHaveAttribute("data-highlighted", "true"));
    await userEvent.keyboard("[Enter]");
    await expect(firstRow).toHaveAttribute("aria-pressed", "true");
    await expect(dot).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(dot);
    await userEvent.click(canvas.getByRole("button", { name: "Select entry 4, Swiss Cheese" }));
    await expect(
      canvas.getByRole("button", { name: "Select entry 4, Swiss Cheese" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(firstRow).toHaveAttribute("aria-pressed", "false");
    await expect(canvas.getAllByRole("region", { name: "Climbing locations" })).toHaveLength(1);
  },
};
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
export const WithRecordedRoute: Story = {
  args: {
    points: [
      { lat: 37.231, lng: -122.114 },
      { lat: 37.234, lng: -122.113 },
      { lat: 37.237, lng: -122.109 },
    ],
  },
};
export const Empty: Story = { args: { entries: [], locations: {} } };
export const NoLocations: Story = { args: { locations: {} } };

export const WithHeartRateChart: Story = {
  render: function Render(args) {
    const [highlightedClimbId, setHighlightedClimbId] = useState<string | null>(null);
    const [selectedClimbId, setSelectedClimbId] = useState<string | null>(null);
    return (
      <div className="space-y-6">
        <MetricsChart
          points={Array.from({ length: 61 }, (_, index) => ({
            recordedAt: new Date(Date.UTC(2026, 9, 18, 17, 30, index * 5)).toISOString(),
            heartRate: Math.round(110 + 30 * Math.sin(index / 8)),
            power: null,
            speed: null,
            cadence: null,
            altitude: null,
            lat: null,
            lng: null,
          }))}
          activityType="climbing"
          hasHr
          hasPower={false}
          hasSpeed={false}
          hasCadence={false}
          loading={false}
          units={new UnitConverter("metric")}
          highlightedClimbId={highlightedClimbId ?? selectedClimbId}
          selectedClimbId={selectedClimbId}
          onSelectClimb={setSelectedClimbId}
          climbAnnotations={args.entries
            .filter((_, index) => index !== 2)
            .map((entry, index) => ({
              id: entry.id,
              label: entry.title ?? entry.climb?.name ?? "Climb",
              startedAt: new Date(Date.UTC(2026, 9, 18, 17, 31 + index)).toISOString(),
              endedAt: index === 1 ? "2026-10-18T17:32:40Z" : null,
            }))}
        />
        <ActivityClimbingPanel
          {...args}
          selectedEntryId={selectedClimbId}
          onSelectEntry={setSelectedClimbId}
          onHighlightEntry={setHighlightedClimbId}
        />
      </div>
    );
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const row = canvas.getByRole("button", { name: "Select entry 1, Swiss Cheese" });
    await userEvent.hover(row);
    await userEvent.hover(canvas.getByRole("heading", { name: "Climbs", level: 2 }));
    row.focus();
  },
};

export const WithAttachmentSuggestions: Story = {
  args: {
    suggestions: [{ ...first, id: "suggestion" }],
    locations: { ...climbingMapLocations, suggestion: exactClimbingLocation },
    onAttach: fn(),
    attachmentStates: {
      suggestion: {
        pending: false,
        error: "Refresh this activity and try attaching this entry again.",
      },
    },
  },
};
export const SuggestionsOnly: Story = {
  args: {
    entries: [],
    suggestions: [first],
    onAttach: fn(),
  },
};
