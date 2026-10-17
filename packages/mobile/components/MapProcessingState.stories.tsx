import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { MapProcessingState } from "./MapProcessingState";

const meta = {
  title: "Activity/MapProcessingState",
  component: MapProcessingState,
  decorators: [
    (Story, context) => (
      <View
        style={{
          width: context.parameters.compact ? 96 : 320,
          height: context.parameters.compact ? 96 : 280,
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof MapProcessingState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
export const Compact: Story = { parameters: { compact: true } };
