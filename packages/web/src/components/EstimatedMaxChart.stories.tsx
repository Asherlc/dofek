import type { Meta, StoryObj } from "@storybook/react-vite";
import type { StrengthExerciseHistoryRow } from "dofek-server/types";
import { EstimatedMaxChart } from "./EstimatedMaxChart.tsx";

const estimatedExercises: Array<{
  exerciseName: string;
  equipment: string | null;
  history: Array<{ date: string; estimatedMax: number; actualWeight: number; actualReps: number }>;
  trend: {
    direction: "increasing" | "decreasing" | "stable";
    summary: string;
    changeMagnitudeKg: number;
    firstDate: string;
    latestDate: string;
  };
}> = [
  {
    exerciseName: "Back Squat",
    equipment: "BARBELL",
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
    equipment: "BARBELL",
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
    equipment: "CABLE",
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
    equipment: "DUMBBELL",
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

const exercises: StrengthExerciseHistoryRow[] = estimatedExercises.map((exercise) => ({
  exerciseName: exercise.exerciseName,
  equipment: exercise.equipment,
  estimatedStrength: exercise,
  exerciseOrder: null,
}));

const orderedExercises: StrengthExerciseHistoryRow[] = [
  {
    exerciseName: "Barbell Back Squat",
    equipment: "BARBELL",
    estimatedStrength: estimatedExercises[0] ?? null,
    exerciseOrder: {
      source: "Crimpd",
      baseline: {
        activityId: "11111111-1111-4111-8111-111111111111",
        date: "2026-06-01",
        position: 3,
        sets: [
          { position: 1, resistance: 100, unit: "KG", reps: 5 },
          { position: 2, resistance: 100, unit: "KG", reps: 5 },
          { position: 3, resistance: 100, unit: "KG", reps: 5 },
        ],
      },
      earlier: {
        activityId: "22222222-2222-4222-8222-222222222222",
        date: "2026-07-01",
        position: 1,
        sets: [
          { position: 1, resistance: 105, unit: "KG", reps: 5 },
          { position: 2, resistance: 105, unit: "KG", reps: 4 },
        ],
      },
    },
  },
  {
    exerciseName: "Nordic Hamstring Curl",
    equipment: null,
    estimatedStrength: null,
    exerciseOrder: {
      source: "Crimpd",
      baseline: {
        activityId: "33333333-3333-4333-8333-333333333333",
        date: "2026-06-10",
        position: 2,
        sets: [{ position: 1, resistance: 0, unit: "LBS", reps: 6 }],
      },
      earlier: null,
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
export const OrderEvidence: Story = {
  args: { exercises: orderedExercises },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
};
export const Loading: Story = { args: { exercises: [], loading: true } };
export const Empty: Story = { args: { exercises: [] } };
