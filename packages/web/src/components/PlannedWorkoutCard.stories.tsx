import type { Meta, StoryObj } from "@storybook/react-vite";
import { samplePlannedWorkout } from "./PlannedWorkoutCard.fixtures.ts";
import { PlannedWorkoutCard } from "./PlannedWorkoutCard.tsx";

const tempoWorkout = {
  ...samplePlannedWorkout,
  id: "tempo",
  title: "Tempo intervals",
  description: null,
  startTime: "07:00",
  steps: samplePlannedWorkout.steps,
};

const snapshotWorkout = {
  ...samplePlannedWorkout,
  id: "endurance",
  title: "Easy endurance",
  description: null,
  startTime: null,
  steps: [],
  snapshotImportedAt: "2026-11-20T12:00:00.000Z",
};

const meta = {
  title: "Activities/PlannedWorkoutCard",
  component: PlannedWorkoutCard,
} satisfies Meta<typeof PlannedWorkoutCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PlannedSession: Story = {
  args: { workout: tempoWorkout },
};

/** Disconnected plan row with Snapshot import date. */
export const SnapshotImport: Story = {
  args: { workout: snapshotWorkout },
};
