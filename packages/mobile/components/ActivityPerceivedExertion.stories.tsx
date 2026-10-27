import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { ActivityPerceivedExertion } from "./ActivityPerceivedExertion";

const meta = {
  title: "Activity/ActivityPerceivedExertion",
  component: ActivityPerceivedExertion,
} satisfies Meta<typeof ActivityPerceivedExertion>;

export default meta;
type Story = StoryObj<typeof meta>;

function Frame({ value }: { value: number | null }) {
  return (
    <View style={{ padding: 16 }}>
      <ActivityPerceivedExertion value={value} />
    </View>
  );
}

export const Unset: Story = { render: () => <Frame value={null} /> };
export const Logged: Story = { render: () => <Frame value={7} /> };
