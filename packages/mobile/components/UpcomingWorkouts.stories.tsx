import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { plannedWorkoutDays } from "./UpcomingWorkouts.fixtures.ts";
import { UpcomingWorkouts } from "./UpcomingWorkouts.tsx";

const meta = {
  title: "Activities/UpcomingWorkouts",
  component: UpcomingWorkouts,
  decorators: [(Story) => <View style={{ width: 360, padding: 16 }}>{Story()}</View>],
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
