import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { StrengthExerciseDetail } from "../../../../../server/src/routers/activity.ts";
import { StrengthExerciseBreakdown } from "./StrengthExerciseBreakdown.tsx";

const exercises: StrengthExerciseDetail[] = [
  {
    activityId: "workout-1",
    exerciseIndex: 0,
    exerciseName: "Bench Press",
    exerciseType: "strength",
    equipment: "BARBELL",
    muscleGroups: ["chest"],
    sets: [
      {
        setIndex: 0,
        setType: "working",
        weightKg: 80,
        reps: 5,
        durationSeconds: 45,
        rpe: 8,
        notes: null,
      },
      {
        setIndex: 1,
        setType: "working",
        weightKg: 82.5,
        reps: 4,
        durationSeconds: null,
        rpe: 9,
        notes: null,
      },
    ],
  },
];

const meta = {
  title: "Pages/ActivityDetail/StrengthExerciseBreakdown",
  component: StrengthExerciseBreakdown,
  args: { exercises, units: new UnitConverter("metric") },
} satisfies Meta<typeof StrengthExerciseBreakdown>;

export default meta;
type Story = StoryObj<typeof meta>;
export const RecordedSets: Story = {};
