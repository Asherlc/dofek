import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ActivityComparisonRow } from "dofek-server/types";
import { UnitContext } from "../lib/unitContext.ts";
import { ActivityComparisonChart } from "./ActivityComparisonChart.tsx";

const routes: ActivityComparisonRow[] = [
  {
    activityName: "Lakeside Loop",
    instances: [
      {
        date: "2026-05-03",
        durationMinutes: 53,
        averagePaceMinPerKm: 6.25,
        avgHeartRate: 142,
        elevationGainMeters: 118,
      },
      {
        date: "2026-05-17",
        durationMinutes: 51,
        averagePaceMinPerKm: 6.02,
        avgHeartRate: 139,
        elevationGainMeters: 121,
      },
      {
        date: "2026-06-01",
        durationMinutes: 49,
        averagePaceMinPerKm: 5.82,
        avgHeartRate: 141,
        elevationGainMeters: 119,
      },
    ],
  },
  {
    activityName: "River Trail",
    instances: [
      {
        date: "2026-05-08",
        durationMinutes: 64,
        averagePaceMinPerKm: 6.8,
        avgHeartRate: 135,
        elevationGainMeters: 74,
      },
      {
        date: "2026-05-24",
        durationMinutes: 61,
        averagePaceMinPerKm: 6.48,
        avgHeartRate: 137,
        elevationGainMeters: 72,
      },
    ],
  },
];

const meta = {
  title: "Hiking/ActivityComparisonChart",
  component: ActivityComparisonChart,
  tags: ["autodocs"],
  args: { data: routes },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActivityComparisonChart>;

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
