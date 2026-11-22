import type { Meta, StoryObj } from "@storybook/react-native";
import type { StrengthExerciseHistoryRow } from "dofek-server/types";
import { View } from "react-native";
import { EstimatedStrengthCard } from "./EstimatedStrengthCard";

const rows: StrengthExerciseHistoryRow[] = [
  {
    exerciseName: "Barbell Back Squat",
    equipment: "BARBELL",
    estimatedStrength: {
      exerciseName: "Barbell Back Squat",
      equipment: "BARBELL",
      history: [
        {
          date: "2026-06-01",
          estimatedMax: 118,
          actualWeight: 100,
          actualReps: 5,
          sourceSetId: "00000000-0000-4000-8000-000000000001",
          provider: "strong-csv",
          fatigueMarker: "Failure" as const,
        },
        {
          date: "2026-07-01",
          estimatedMax: 128,
          actualWeight: 110,
          actualReps: 5,
          sourceSetId: "00000000-0000-4000-8000-000000000001",
          provider: "strong-csv",
          fatigueMarker: "Failure" as const,
        },
      ],
      trend: {
        direction: "increasing",
        summary: "Estimated max increased from first to latest estimate.",
        changeMagnitudeKg: 10,
        firstDate: "2026-06-01",
        latestDate: "2026-07-01",
      },
    },
    exerciseOrder: {
      source: "Crimpd",
      baseline: {
        activityId: "11111111-1111-4111-8111-111111111111",
        date: "2026-06-01",
        position: 3,
        sets: [
          { position: 1, resistance: 100, unit: "KG", reps: 5 },
          { position: 2, resistance: 100, unit: "KG", reps: 5 },
        ],
      },
      earlier: {
        activityId: "22222222-2222-4222-8222-222222222222",
        date: "2026-07-01",
        position: 1,
        sets: [{ position: 1, resistance: 105, unit: "KG", reps: 5 }],
      },
    },
  },
  {
    exerciseName: "Weighted Pull Up",
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
  title: "Training/EstimatedStrengthCard",
  component: EstimatedStrengthCard,
  decorators: [
    (Story) => (
      <View style={{ padding: 16 }}>
        <Story />
      </View>
    ),
  ],
  args: { rows, loading: false, error: null },
} satisfies Meta<typeof EstimatedStrengthCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { rows: [], loading: true, error: null } };
export const ErrorWithoutData: Story = {
  args: { rows: [], loading: false, error: "Could not load estimated strength." },
};
export const StaleRefreshError: Story = {
  args: { error: "Network unavailable" },
};
