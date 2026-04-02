import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import LoginScreen from "./login";

const meta = {
  title: "Pages/Login",
  component: LoginScreen,
} satisfies Meta<typeof LoginScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <LoginScreen />
    </View>
  ),
};
