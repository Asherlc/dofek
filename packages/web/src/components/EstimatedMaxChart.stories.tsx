import type { Meta, StoryObj } from "@storybook/react-vite";
import type { EstimatedOneRepMaxRow } from "dofek-server/types";
import { EstimatedMaxChart } from "./EstimatedMaxChart.tsx";

const exercises: EstimatedOneRepMaxRow[] = [
  {
    exerciseName: "Back Squat",
    equipment: "BARBELL",
    history: [
      {
        date: "2026-06-01",
        estimatedMax: 116.7,
        actualWeight: 100,
        actualReps: 5,
        sourceSetId: "00000000-0000-4000-8000-000000000001",
        provider: "strong-csv",
        fatigueMarker: "Failure" as const,
      },
      {
        date: "2026-06-15",
        estimatedMax: 122.5,
        actualWeight: 105,
        actualReps: 5,
        sourceSetId: "00000000-0000-4000-8000-000000000002",
        provider: "strong-csv",
        fatigueMarker: "Failure" as const,
      },
      {
        date: "2026-07-01",
        estimatedMax: 128.3,
        actualWeight: 110,
        actualReps: 5,
        sourceSetId: "00000000-0000-4000-8000-000000000003",
        provider: "strong-csv",
        fatigueMarker: "Failure" as const,
      },
    ],
    trend: {
      direction: "increasing",
      summary: "Estimated max increased from first to latest estimate.",
      changeMagnitudeKg: 11.6,
      firstDate: "2026-06-01",
      latestDate: "2026-07-01",
    },
  },
  {
    exerciseName: "Bench Press",
    equipment: "BARBELL",
    history: [
      {
        date: "2026-06-01",
        estimatedMax: 85,
        actualWeight: 75,
        actualReps: 4,
        sourceSetId: "00000000-0000-4000-8000-000000000004",
        provider: "strong-csv",
        fatigueMarker: "Failure" as const,
      },
      {
        date: "2026-06-15",
        estimatedMax: 87.3,
        actualWeight: 77,
        actualReps: 4,
        sourceSetId: "00000000-0000-4000-8000-000000000006",
        provider: "strong-csv",
        fatigueMarker: "Failure",
      },
      {
        date: "2026-07-01",
        estimatedMax: 90.7,
        actualWeight: 80,
        actualReps: 4,
        sourceSetId: "00000000-0000-4000-8000-000000000005",
        provider: "strong-csv",
        fatigueMarker: "Failure" as const,
      },
    ],
    trend: {
      direction: "increasing",
      summary: "Estimated max increased from first to latest estimate.",
      changeMagnitudeKg: 5.7,
      firstDate: "2026-06-01",
      latestDate: "2026-07-01",
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
