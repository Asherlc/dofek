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
    trend: {
      direction: "increasing",
      summary: "Estimated max increased from first to latest estimate.",
      changeMagnitudeKg: 10,
      firstDate: "2026-06-01",
      latestDate: "2026-07-01",
    },
  },
  {
    exerciseName: "Bench Press",
    history: [
      { date: "2026-06-01", estimatedMax: 86, actualWeight: 75, actualReps: 4 },
      { date: "2026-07-01", estimatedMax: 91, actualWeight: 80, actualReps: 4 },
    ],
    trend: {
      direction: "increasing",
      summary: "Estimated max increased from first to latest estimate.",
      changeMagnitudeKg: 5,
      firstDate: "2026-06-01",
      latestDate: "2026-07-01",
    },
  },
  {
    exerciseName: "Single-Arm Cable Row",
    history: [
      { date: "2026-06-03", estimatedMax: 70, actualWeight: 60, actualReps: 5 },
      { date: "2026-07-03", estimatedMax: 65, actualWeight: 55, actualReps: 5 },
    ],
    trend: {
      direction: "decreasing",
      summary: "Estimated max decreased from first to latest estimate.",
      changeMagnitudeKg: 5,
      firstDate: "2026-06-03",
      latestDate: "2026-07-03",
    },
  },
  {
    exerciseName: "Bulgarian Split Squat",
    history: [
      { date: "2026-06-05", estimatedMax: 45, actualWeight: 40, actualReps: 4 },
      { date: "2026-07-05", estimatedMax: 45, actualWeight: 40, actualReps: 4 },
    ],
    trend: {
      direction: "stable",
      summary: "Estimated max did not change from first to latest estimate.",
      changeMagnitudeKg: 0,
      firstDate: "2026-06-05",
      latestDate: "2026-07-05",
    },
  },
];

const meta = {
  title: "Strength/EstimatedMaxChart",
  component: EstimatedMaxChart,
  args: { exercises },
} satisfies Meta<typeof EstimatedMaxChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DesktopManyExercises: Story = {
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
};
export const MobileManyExercises: Story = {
  decorators: [
    (Story) => (
      <div className="w-[320px] p-4">
        <Story />
      </div>
    ),
  ],
};
export const Loading: Story = { args: { exercises: [], loading: true } };
export const Empty: Story = { args: { exercises: [] } };
