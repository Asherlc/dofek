import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { View } from "react-native";
import { ClimbingFilters } from "./ClimbingFilters";

const meta = {
  title: "Components/ClimbingFilters",
  component: ClimbingFilters,
  args: { value: {}, onChange: () => {} },
} satisfies Meta<typeof ClimbingFilters>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value);
    return (
      <View style={{ width: 360, padding: 16 }}>
        <ClimbingFilters value={value} onChange={setValue} />
      </View>
    );
  },
};
export const Selected: Story = {
  ...Default,
  args: { value: { types: ["lead"], protectionUsed: ["trad"], setting: ["outdoor"] } },
};
export const BoardOnly: Story = {
  ...Default,
  args: { value: { types: ["bouldering"], setting: ["indoor"], board: ["recorded"] } },
};
export const NoBoardRecorded: Story = {
  ...Default,
  args: { value: { types: ["bouldering"], setting: ["indoor"], board: ["not_recorded"] } },
};
