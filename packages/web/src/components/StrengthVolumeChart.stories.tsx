import type { Meta, StoryObj } from "@storybook/react-vite";
import type { VolumeOverTimeRow } from "dofek-server/types";
import { StrengthVolumeChart } from "./StrengthVolumeChart.tsx";

const volumeData: VolumeOverTimeRow[] = [
  { week: "2026-05-04", totalVolumeKg: 8_450, setCount: 42, workoutCount: 3 },
  { week: "2026-05-11", totalVolumeKg: 9_180, setCount: 45, workoutCount: 3 },
  { week: "2026-05-18", totalVolumeKg: 10_240, setCount: 51, workoutCount: 4 },
  { week: "2026-05-25", totalVolumeKg: 7_900, setCount: 38, workoutCount: 3 },
  { week: "2026-06-01", totalVolumeKg: 11_350, setCount: 54, workoutCount: 4 },
];

const meta = {
  title: "Strength/StrengthVolumeChart",
  component: StrengthVolumeChart,
  tags: ["autodocs"],
  args: { data: volumeData },
  decorators: [
    (Story) => (
      <div className="w-[720px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StrengthVolumeChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
