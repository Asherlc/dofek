import type { ClimbingMapMarker } from "@dofek/training/climbing-map";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import "leaflet/dist/leaflet.css";
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
export const PointsOnly: Story = { args: { points: [], climbMarkers: markers } };
export const ExactClimb: Story = {
  args: { points: [], climbMarkers: markers.slice(0, 1), presentation: "compact" },
};
export const Area: Story = {
  args: { points: [], climbMarkers: markers.slice(1), presentation: "compact" },
};
export const RepeatedPoint: Story = {
  args: {
    points: [],
    climbMarkers: markers
      .slice(0, 1)
      .flatMap((marker) => [marker, { ...marker, entryId: "tick-repeat" }]),
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
    await expect(preview).not.toHaveClass("leaflet-container");
    await expect(canvasElement.querySelector("img.leaflet-tile")).toBeNull();
    preview.scrollIntoView({ block: "center" });
    await waitFor(() => expect(preview).toHaveClass("leaflet-container"));
    await waitFor(() => expect(canvasElement.querySelector("img.leaflet-tile")).not.toBeNull());
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
export const TileError: Story = {
  ...ExactClimb,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector("img.leaflet-tile")).not.toBeNull());
    canvasElement.querySelector("img.leaflet-tile")?.dispatchEvent(new Event("error"));
    await expect(within(canvasElement).findByRole("status")).resolves.toHaveTextContent(
      "Map unavailable",
    );
  },
};
