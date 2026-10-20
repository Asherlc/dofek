import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActivityTypeIcon } from "./ActivityTypeIcon.tsx";

const meta = {
  title: "Activities/ActivityTypeIcon",
  component: ActivityTypeIcon,
  args: {
    activityType: "indoor_cycling",
  },
} satisfies Meta<typeof ActivityTypeIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Card: Story = {};
export const Compact: Story = { args: { variant: "compact" } };
export const Plain: Story = { args: { variant: "plain" } };
export const StrengthTraining: Story = { args: { activityType: "strength_training" } };
export const Hangboarding: Story = { args: { activityType: "hangboard" } };
export const HangboardingCompact: Story = {
  args: { activityType: "hangboard", variant: "compact" },
};
export const HangboardingPlain: Story = {
  args: { activityType: "hangboard", variant: "plain" },
};
