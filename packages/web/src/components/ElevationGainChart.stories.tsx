import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ElevationProfileRow } from "dofek-server/types";
import { UnitContext } from "../lib/unitContext.ts";
import { ElevationGainChart } from "./ElevationGainChart.tsx";

const weeks: ElevationProfileRow[] = [
  { week: "2026-05-04", elevationGainMeters: 420, activityCount: 3, totalDistanceKm: 27.4 },
  { week: "2026-05-11", elevationGainMeters: 685, activityCount: 4, totalDistanceKm: 34.1 },
  { week: "2026-05-18", elevationGainMeters: 510, activityCount: 2, totalDistanceKm: 24.8 },
  { week: "2026-05-25", elevationGainMeters: 940, activityCount: 5, totalDistanceKm: 42.6 },
  { week: "2026-06-01", elevationGainMeters: 760, activityCount: 4, totalDistanceKm: 38.2 },
];

const meta = {
  title: "Hiking/ElevationGainChart",
  component: ElevationGainChart,
  tags: ["autodocs"],
  args: { data: weeks },
  decorators: [
    (Story) => (
      <div className="w-[720px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ElevationGainChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
export const Imperial: Story = {
  decorators: [
    (Story) => (
      <UnitContext.Provider value={{ unitSystem: "imperial", setUnitSystem: () => {} }}>
        <Story />
      </UnitContext.Provider>
    ),
  ],
};
