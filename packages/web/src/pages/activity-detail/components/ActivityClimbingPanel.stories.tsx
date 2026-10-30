import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, waitFor, within } from "storybook/test";
import "maplibre-gl/dist/maplibre-gl.css";
import { ActivityClimbingPanel } from "./ActivityClimbingPanel.tsx";
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
