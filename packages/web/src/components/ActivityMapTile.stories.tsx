import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActivityMapTile } from "./ActivityMapTile.tsx";

const mapPreview = {
  width: 1024,
  height: 576,
  tiles: [
    {
      url: "https://tile.openstreetmap.org/19/83856/202646.png",
      x: -179.332,
      y: -132.862,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83857/202646.png",
      x: 76.668,
      y: -132.862,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83858/202646.png",
      x: 332.668,
      y: -132.862,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83859/202646.png",
      x: 588.668,
      y: -132.862,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83860/202646.png",
      x: 844.668,
      y: -132.862,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83856/202647.png",
      x: -179.332,
      y: 123.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83857/202647.png",
      x: 76.668,
      y: 123.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83858/202647.png",
      x: 332.668,
      y: 123.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83859/202647.png",
      x: 588.668,
      y: 123.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83860/202647.png",
      x: 844.668,
      y: 123.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83856/202648.png",
      x: -179.332,
      y: 379.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83857/202648.png",
      x: 76.668,
      y: 379.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83858/202648.png",
      x: 332.668,
      y: 379.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83859/202648.png",
      x: 588.668,
      y: 379.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83860/202648.png",
      x: 844.668,
      y: 379.138,
      width: 256,
      height: 256,
    },
  ],
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

export const NoRoute: Story = {
  args: {
    location: {
      mapPreview: {
        ...mapPreview,
        routePath: null,
      },
    },
  },
};
