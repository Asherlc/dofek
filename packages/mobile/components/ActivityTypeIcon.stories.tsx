import type { Meta, StoryObj } from "@storybook/react-native";
import { ActivityTypeIcon } from "./ActivityTypeIcon";

const meta = {
  title: "Activities/ActivityTypeIcon",
  component: ActivityTypeIcon,
  args: { activityType: "hangboard" },
} satisfies Meta<typeof ActivityTypeIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Hangboarding: Story = {};
export const Compact: Story = { args: { size: 32 } };
export const Running: Story = { args: { activityType: "running" } };
export const UnknownActivity: Story = { args: { activityType: "other" } };
