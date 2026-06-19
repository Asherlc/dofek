import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActivityMapTile } from "./ActivityMapTile.tsx";

const metricUnits = new UnitConverter("metric");

const meta = {
  title: "Activities/ActivityMapTile",
  component: ActivityMapTile,
  tags: ["autodocs"],
  args: {
    units: metricUnits,
    location: {
      tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
      routePath: [
        { x: 20, y: 38 },
        { x: 26, y: 46 },
        { x: 28, y: 21 },
        { x: 31, y: 58 },
        { x: 52, y: 59 },
        { x: 59, y: 73 },
        { x: 67, y: 68 },
        { x: 75, y: 54 },
        { x: 83, y: 49 },
        { x: 79, y: 43 },
        { x: 91, y: 51 },
      ],
      distanceMeters: 8530,
      elevationGainM: 493,
    },
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl bg-background p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActivityMapTile>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CoarseRoute: Story = {};

export const NoRoute: Story = {
  args: {
    location: {
      tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
      distanceMeters: 5000,
      elevationGainM: 120,
    },
  },
};
