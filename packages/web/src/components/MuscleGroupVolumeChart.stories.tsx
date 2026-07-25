import type { Meta, StoryObj } from "@storybook/react-vite";
import type { MuscleGroupVolumeRow } from "dofek-server/types";
import { MuscleGroupVolumeChart } from "./MuscleGroupVolumeChart.tsx";

const muscleGroups: MuscleGroupVolumeRow[] = [
  {
    muscleGroup: "CHEST",
    weeklyData: [
      { week: "2026-05-18", sets: 12 },
      { week: "2026-05-25", sets: 14 },
      { week: "2026-06-01", sets: 15 },
    ],
  },
  {
    muscleGroup: "BACK",
    weeklyData: [
      { week: "2026-05-18", sets: 18 },
      { week: "2026-05-25", sets: 20 },
      { week: "2026-06-01", sets: 22 },
    ],
  },
  {
    muscleGroup: "LEGS",
    weeklyData: [
      { week: "2026-05-18", sets: 16 },
      { week: "2026-05-25", sets: 12 },
      { week: "2026-06-01", sets: 20 },
    ],
  },
  {
    muscleGroup: "SHOULDERS",
    weeklyData: [
      { week: "2026-05-18", sets: 8 },
      { week: "2026-05-25", sets: 10 },
      { week: "2026-06-01", sets: 9 },
    ],
  },
  {
    muscleGroup: "CORE",
    weeklyData: [
      { week: "2026-05-18", sets: 6 },
      { week: "2026-05-25", sets: 8 },
      { week: "2026-06-01", sets: 10 },
    ],
  },
];

const meta = {
  title: "Strength/MuscleGroupVolumeChart",
  component: MuscleGroupVolumeChart,
  tags: ["autodocs"],
  args: { data: muscleGroups },
  decorators: [
    (Story) => (
      <div className="w-[520px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MuscleGroupVolumeChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
