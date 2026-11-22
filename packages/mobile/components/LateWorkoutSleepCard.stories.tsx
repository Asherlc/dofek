import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { LateWorkoutSleepCard } from "./LateWorkoutSleepCard";
import {
  emptyLateWorkoutSleep,
  matchedLateWorkoutSleep,
  timingOnlyLateWorkoutSleep,
} from "./late-workout-sleep-fixtures";

const meta = {
  title: "Sleep/LateWorkoutSleepCard",
  component: LateWorkoutSleepCard,
  decorators: [(Story) => <View style={{ width: 360, padding: 16 }}>{Story()}</View>],
} satisfies Meta<typeof LateWorkoutSleepCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Matched: Story = { args: { data: matchedLateWorkoutSleep } };
export const TimingOnly: Story = { args: { data: timingOnlyLateWorkoutSleep } };
export const Empty: Story = { args: { data: emptyLateWorkoutSleep } };
export const Loading: Story = { args: { isLoading: true } };
