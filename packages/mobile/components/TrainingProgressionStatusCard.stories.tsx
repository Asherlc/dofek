import type { Meta, StoryObj } from "@storybook/react-native";
import { Text } from "react-native";
import { TrainingProgressionStatusCard } from "./TrainingProgressionStatusCard";

const meta = {
  title: "Training/TrainingProgressionStatusCard",
  component: TrainingProgressionStatusCard,
  args: {
    status: "ready",
    headline: "Bench press · Barbell",
    summary: "More reps at the same weight",
  },
} satisfies Meta<typeof TrainingProgressionStatusCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const Stagnating: Story = {
  args: {
    status: "stagnating",
    headline: "Squat · Barbell",
    summary: "Estimated strength held steady across 7 comparable sessions.",
  },
};
export const NoBadge: Story = { args: { status: null } };
export const WithEvidence: Story = {
  args: {
    details: <Text>Nov 20, 2026 · 60 kg · 10 reps · whoop</Text>,
  },
};
