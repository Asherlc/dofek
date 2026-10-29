import type { ClimbingMapMarker } from "@dofek/training/climbing-map";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import "maplibre-gl/dist/maplibre-gl.css";
import { ActivityRouteMap } from "./ActivityRouteMap.tsx";

const markers: ClimbingMapMarker[] = [
  {
    entryId: "tick-1",
    label: "Swiss Cheese",
    location: {
      coordinates: { latitude: 37.234, longitude: -122.111 },
      scope: "climb",
      objectId: "swiss-cheese",
      providerId: "mountain-project",
      name: "Swiss Cheese",
    },
  },
  {
    entryId: "tick-2",
    label: "Left Arete",
    location: {
      coordinates: { latitude: 37.236, longitude: -122.112 },
      scope: "area",
      objectId: "goat-rock",
      providerId: "openbeta",
      name: "Goat Rock",
    },
  },
];
const meta = {
  title: "Activity Detail/ActivityRouteMap",
  component: ActivityRouteMap,
  parameters: { layout: "fullscreen" },
  args: {
    points: [
      { lat: 37.231, lng: -122.114 },
      { lat: 37.234, lng: -122.113 },
      { lat: 37.237, lng: -122.109 },
    ],
  },
} satisfies Meta<typeof ActivityRouteMap>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const RoutePlusDots: Story = { args: { climbMarkers: markers } };
export const PointsOnly: Story = {
  args: { points: [], climbMarkers: markers, onSelectEntry: fn() },
  play: async ({ args, canvasElement }) => {
    const dot = await within(canvasElement).findByRole("button", {
      name: "Swiss Cheese · Climb location: Swiss Cheese · Mountain Project",
    });
    const bounds = dot.getBoundingClientRect();
    dot.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: bounds.x + bounds.width / 2,
        clientY: bounds.y + bounds.height / 2,
      }),
    );
    await expect(args.onSelectEntry).toHaveBeenLastCalledWith("tick-1");
  },
};
export const ExactClimb: Story = {
  args: { points: [], climbMarkers: markers.slice(0, 1), presentation: "compact" },
};
export const Area: Story = {
  args: { points: [], climbMarkers: markers.slice(1), presentation: "compact" },
};
export const AreaTooltip: Story = {
  args: {
    points: [],
    climbMarkers: [
      {
        entryId: "bits-and-bits",
        label: "Bits and Bits",
        location: {
          coordinates: { latitude: 39.323, longitude: -120.599 },
          scope: "area",
          objectId: "johnny-wall",
          providerId: "mountain-project",
          name: "Johnny Wall",
        },
      },
    ],
  },
  decorators: [
    (Story) => (
      <div style={{ width: 560, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dot = await canvas.findByLabelText(
      "Bits and Bits · Area location: Johnny Wall · Mountain Project",
    );
    await userEvent.hover(dot);
    const tooltip = await canvas.findByRole("tooltip");
    const bounds = tooltip.getBoundingClientRect();
    await expect(bounds.width).toBeGreaterThan(200);
    await expect(bounds.width).toBeLessThan(280);
    await expect(bounds.height).toBeLessThan(100);
  },
};
export const RepeatedPoint: Story = {
  args: {
    points: [],
    climbMarkers: markers
      .slice(0, 1)
      .flatMap((marker) => [marker, { ...marker, entryId: "tick-repeat" }]),
    onSelectEntry: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const dot = await canvas.findByRole("button", {
      name: "2 climbs · Swiss Cheese · Swiss Cheese · Climb location: Swiss Cheese · Mountain Project",
    });
    const bounds = dot.getBoundingClientRect();
    dot.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: bounds.x + bounds.width / 2,
        clientY: bounds.y + bounds.height / 2,
      }),
    );
    const choices = await canvas.findAllByRole("button", { name: "Swiss Cheese" });
    const repeat = choices[1];
    if (!repeat) throw new Error("Expected the repeated climb choice");
    await userEvent.click(repeat);
    await expect(args.onSelectEntry).toHaveBeenLastCalledWith("tick-repeat");
  },
};
export const SharedAreaClimbs: Story = {
  args: {
    points: [],
    climbMarkers: ["Bits and Bits", "Kibbles and Bits", "Blue Arete", "Left Arete"].map(
      (label, index) => ({
        entryId: `johnny-wall-${index}`,
        label,
        location: {
          coordinates: { latitude: 39.323, longitude: -120.599 },
          scope: "area" as const,
          objectId: "johnny-wall",
          providerId: "mountain-project",
          name: "Johnny Wall",
        },
      }),
    ),
    onSelectEntry: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const marker = await canvas.findByRole("button", { name: /^4 climbs ·/ });
    await expect(marker).toHaveTextContent("4");
    await userEvent.hover(marker);
    await expect(canvas.getByRole("tooltip")).toHaveTextContent(
      "Bits and Bits · Kibbles and Bits · Blue Arete · Left Arete",
    );
    const markerBounds = marker.getBoundingClientRect();
    marker.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: markerBounds.x + markerBounds.width / 2,
        clientY: markerBounds.y + markerBounds.height / 2,
      }),
    );
    const choices = within(
      await canvas.findByRole("list", { name: "Climbing entries at this location" }),
    );
    for (const entry of args.climbMarkers ?? []) {
      await userEvent.click(choices.getByRole("button", { name: entry.label }));
      await expect(args.onSelectEntry).toHaveBeenLastCalledWith(entry.entryId);
    }
  },
};
export const Empty: Story = { args: { points: [] } };
export const LazyOffscreenPreview: Story = {
  ...ExactClimb,
  render: (args) => (
    <div style={{ height: 400, overflowY: "auto" }}>
      <p>Scroll to the climb preview.</p>
      <div style={{ height: 1200 }} />
      <ActivityRouteMap {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const preview = within(canvasElement).getByRole("region", { name: "Climbing locations" });
    await expect(preview).not.toHaveClass("maplibregl-map");
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent("Processing map…");
    await expect(canvasElement.querySelector("canvas.maplibregl-canvas")).toBeNull();
    preview.scrollIntoView({ block: "center" });
    await waitFor(() => expect(preview).toHaveClass("maplibregl-map"));
    await waitFor(() =>
      expect(canvasElement.querySelector("canvas.maplibregl-canvas")).not.toBeNull(),
    );
  },
};
export const Narrow: Story = {
  ...RoutePlusDots,
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
export const Wide: Story = {
  ...RoutePlusDots,
  decorators: [
    (Story) => (
      <div style={{ width: 1000, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
