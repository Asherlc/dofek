import type { Meta, StoryObj } from "@storybook/react-vite";
import type { VerticalAscentRow } from "dofek-server/types";
import { UnitContext } from "../lib/unitContext.ts";
import { VerticalAscentChart } from "./VerticalAscentChart.tsx";

const activities: VerticalAscentRow[] = [
  {
    date: "2026-04-18",
    activityName: "Hill Country Tempo",
    activityType: "cycling",
    modality: "road",
    verticalAscentRate: 610,
    elevationGainMeters: 890,
    elapsedMinutes: 112,
  },
  {
    date: "2026-05-02",
    activityName: "Rocky Ridge",
    activityType: "mountain_biking",
    modality: "mountain",
    verticalAscentRate: 475,
    elevationGainMeters: 720,
    elapsedMinutes: 128,
  },
  {
    date: "2026-05-16",
    activityName: "Gravel Escarpment",
    activityType: "gravel_cycling",
    modality: "gravel",
    verticalAscentRate: 535,
    elevationGainMeters: 1_240,
    elapsedMinutes: 166,
  },
  {
    date: "2026-05-30",
    activityName: "Summit Repeats",
    activityType: "road_cycling",
    modality: "road",
    verticalAscentRate: 780,
    elevationGainMeters: 1_560,
    elapsedMinutes: 142,
  },
];

const meta = {
  title: "Training/VerticalAscentChart",
  component: VerticalAscentChart,
  tags: ["autodocs"],
  args: { data: activities },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof VerticalAscentChart>;

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
