import type { Meta, StoryObj } from "@storybook/react-native";
import { AlertsBell } from "./AlertsBell";

const meta = {
  title: "Navigation/AlertsBell",
  component: AlertsBell,
  args: {
    activeCount: 3,
    onPress: () => undefined,
  },
} satisfies Meta<typeof AlertsBell>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Active: Story = {};

export const Empty: Story = {
  args: {
    activeCount: 0,
  },
};
