import type { Meta, StoryObj } from "@storybook/react-vite";
import { plannedWorkoutDays } from "./UpcomingWorkouts.fixtures.ts";
import { UpcomingWorkouts } from "./UpcomingWorkouts.tsx";

const meta = {
  title: "Components/UpcomingWorkouts",
  component: UpcomingWorkouts,
} satisfies Meta<typeof UpcomingWorkouts>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PlannedSession: Story = {
  args: { days: plannedWorkoutDays },
};

export const Loading: Story = {
  args: { days: undefined, isLoading: true },
};

export const Empty: Story = {
  args: { days: [] },
};

export const ErrorWithRetry: Story = {
  args: {
    days: undefined,
    isError: true,
    error: new Error("Schedule is temporarily unavailable."),
    onRetry: () => undefined,
  },
};
