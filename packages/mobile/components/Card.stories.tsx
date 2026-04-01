import type { Meta, StoryObj } from "@storybook/react-native";
import { Text } from "react-native";
import { Card } from "./Card";

const meta = {
  title: "Layout/Card",
  component: Card,
  args: {
    title: "Recovery",
    children: <Text>Ready for a moderate workout today.</Text>,
  },
} satisfies Meta<typeof Card>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutTitle: Story = {
  args: {
    title: undefined,
    children: <Text>Cards can also render plain content with no section label.</Text>,
  },
};
