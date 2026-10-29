import type { Meta, StoryObj } from "@storybook/react-vite";
import { climbingSourceLocation } from "./ActivityMapTile.fixtures.ts";
import { ActivityMapTile } from "./ActivityMapTile.tsx";

const mapPreview = {
  width: 1024,
  height: 576,
  center: [-122.41879999995231, 37.775250001673115] satisfies [number, number],
  zoom: 18,
  routePath: [
    { x: 288.304, y: 453.089 },
    { x: 512, y: 311.585 },
    { x: 735.696, y: 122.911 },
  ],
};

const meta = {
  title: "Activities/ActivityMapTile",
  component: ActivityMapTile,
  tags: ["autodocs"],
  args: {
    location: {
      kind: "recorded_gps",
      centroidLat: 37.7749,
      centroidLng: -122.4194,
      mapPreview,
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full bg-background p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActivityMapTile>;

export default meta;

type Story = StoryObj<typeof meta>;

export const HighResolutionRoute: Story = {};

export const Processing: Story = { args: { location: { kind: "processing" } } };
export const ProcessingThumbnail: Story = {
  args: { location: { kind: "processing" }, variant: "thumbnail" },
};

export const NoRoute: Story = {
  args: {
    location: {
      kind: "recorded_gps",
      centroidLat: 37.7749,
      centroidLng: -122.4194,
      mapPreview: {
        ...mapPreview,
        routePath: null,
      },
    },
  },
};

export const ClimbingSourceLocations: Story = {
  name: "Climbing source points",
  args: {
    location: climbingSourceLocation,
  },
};
