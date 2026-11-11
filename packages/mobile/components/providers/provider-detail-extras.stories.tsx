import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { colors } from "../../theme";
import { ProviderDetailExtras } from "./provider-detail-extras";

const meta = {
  title: "Providers/ProviderDetailExtras",
  component: ProviderDetailExtras,
  args: { providerId: "garmin" },
  decorators: [
    (Story) => (
      <View style={{ padding: 16, backgroundColor: colors.background }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ProviderDetailExtras>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Garmin: Story = {};
