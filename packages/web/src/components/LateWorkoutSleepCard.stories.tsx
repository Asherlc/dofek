import type { Meta, StoryObj } from "@storybook/react-vite";
import { LateWorkoutSleepCard } from "./LateWorkoutSleepCard.tsx";
import {
  emptyLateWorkoutSleep,
  matchedLateWorkoutSleep,
  timingOnlyLateWorkoutSleep,
} from "./late-workout-sleep-fixtures.ts";

const meta = {
  title: "Sleep/LateWorkoutSleepCard",
  component: LateWorkoutSleepCard,
} satisfies Meta<typeof LateWorkoutSleepCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Matched: Story = { args: { data: matchedLateWorkoutSleep } };
export const TimingOnly: Story = { args: { data: timingOnlyLateWorkoutSleep } };
export const Empty: Story = { args: { data: emptyLateWorkoutSleep } };
export const Loading: Story = { args: { isLoading: true } };
