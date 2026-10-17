import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, waitFor, within } from "storybook/test";
import "leaflet/dist/leaflet.css";
import { ClimbingLocationMap } from "./ClimbingLocationMap.tsx";
import { climbingLocationMapFixture } from "./climbing-location-map-test-helpers.ts";

const meta = {
  title: "Training/ClimbingLocationMap",
  component: ClimbingLocationMap,
  parameters: { layout: "padded" },
  args: { data: climbingLocationMapFixture },
} satisfies Meta<typeof ClimbingLocationMap>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const ExploreClimbs: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const cluster = await canvas.findByRole("button", { name: "3 climbs. Zoom in to explore." });
    fireEvent.click(cluster);
    const dot = await canvas.findByRole("button", { name: "2 climbs. Show climb details." });
    fireEvent.focus(dot);
    await waitFor(() =>
      expect(
        canvas.getByText("2 climbs. Show climb details.").getBoundingClientRect().width,
      ).toBeGreaterThan(100),
    );
    fireEvent.keyDown(dot, { key: "Enter" });
    const list = await canvas.findByRole("list", { name: "Climbs at this location" });
    await expect(within(list).getByText("Left Arete")).toBeVisible();
    await expect(within(list).getByText("Area location: Goat Rock · OpenBeta")).toBeVisible();
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
export const Wide: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 1000, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
export const Loading: Story = {
  args: { data: undefined, loading: true },
  parameters: {
    docs: {
      description: {
        story:
          "The reserved map area shows its processing status before location data or initial map tiles are ready.",
      },
    },
  },
};
export const Empty: Story = { args: { data: { bounds: null, nodes: [] } } };
export const Refreshing: Story = { args: { loading: true } };
export const TileError: Story = {
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector("img.leaflet-tile")).not.toBeNull());
    canvasElement.querySelector("img.leaflet-tile")?.dispatchEvent(new Event("error"));
    await expect(within(canvasElement).findByRole("status")).resolves.toHaveTextContent(
      "Some map tiles could not load",
    );
    await expect(
      within(canvasElement).getByRole("region", { name: "Climbing locations" }),
    ).toBeVisible();
  },
};
