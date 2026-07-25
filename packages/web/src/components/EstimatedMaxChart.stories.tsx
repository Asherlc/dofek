import type { Meta, StoryObj } from "@storybook/react-vite";
import type { EstimatedOneRepMaxRow } from "dofek-server/types";
import { EstimatedMaxChart } from "./EstimatedMaxChart.tsx";

const exercises: EstimatedOneRepMaxRow[] = [
  {
    exerciseName: "Back Squat",
    history: [
      { date: "2026-06-01", estimatedMax: 118, actualWeight: 100, actualReps: 5 },
      { date: "2026-06-15", estimatedMax: 123, actualWeight: 105, actualReps: 5 },
      { date: "2026-07-01", estimatedMax: 128, actualWeight: 110, actualReps: 5 },
    ],
  },
  {
    exerciseName: "Bench Press",
    history: [
      { date: "2026-06-01", estimatedMax: 86, actualWeight: 75, actualReps: 4 },
      { date: "2026-07-01", estimatedMax: 91, actualWeight: 80, actualReps: 4 },
    ],
  },
];

const meta = {
  title: "Strength/EstimatedMaxChart",
  component: EstimatedMaxChart,
  args: { exercises },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EstimatedMaxChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = { args: { exercises: [] } };
