import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ElevationChart } from "./ActivityDetailPage.tsx";

const meta = {
  title: "Pages/ActivityDetail/Elevation",
  component: ElevationChart,
  decorators: [
    (Story) => (
      <div className="w-[600px] p-6">
        <Story />
      </div>
    ),
  ],
  args: {
    points: [2450, 2460, 2450, 2500, 2540, 2480, 2400, 2320, 2280, 2300, 2270].map(
      (altitude, index) => ({
        recordedAt: new Date(Date.UTC(2026, 9, 4, 16, index * 5)).toISOString(),
        altitude,
        heartRate: null,
        power: null,
        speed: null,
        cadence: null,
        lat: null,
        lng: null,
      }),
    ),
    loading: false,
    units: new UnitConverter("metric"),
  },
} satisfies Meta<typeof ElevationChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const HighElevation: Story = {};
export const Imperial: Story = { args: { units: new UnitConverter("imperial") } };
export const BelowSeaLevel: Story = {
  args: {
    points: meta.args.points.map((point) => ({ ...point, altitude: point.altitude - 2700 })),
  },
};
export const Flat: Story = {
  args: { points: meta.args.points.map((point) => ({ ...point, altitude: 2400 })) },
};
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = { args: { points: [] } };
