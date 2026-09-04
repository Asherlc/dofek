import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { McpClientSetupPanel } from "./McpClientSetupPanel";

const meta = {
  title: "Settings/McpClientSetupPanel",
  component: McpClientSetupPanel,
  args: { endpoint: "https://dofek.fit/api/mcp" },
  decorators: [
    (Story) => (
      <View style={{ padding: 16, width: 390 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof McpClientSetupPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
