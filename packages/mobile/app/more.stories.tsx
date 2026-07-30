import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { colors } from "../theme";
import MoreScreen from "./more";

const meta = {
  title: "Pages/More",
  component: MoreScreen,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof MoreScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
