import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { OperationProgressBar } from "./OperationProgressBar";

const meta = {
  title: "State/OperationProgressBar",
  component: OperationProgressBar,
  decorators: [
    (Story) => (
      <View style={{ width: 360, padding: 16 }}>
        <Story />
      </View>
    ),
  ],
  args: {
    percentage: 45,
    message: "Syncing activities...",
  },
} satisfies Meta<typeof OperationProgressBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Indeterminate: Story = {
  args: {
    percentage: undefined,
    message: "Deleting provider records...",
  },
};

export const Complete: Story = {
  args: {
    percentage: 100,
    message: "Operation complete",
  },
};
