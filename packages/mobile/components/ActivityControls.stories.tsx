import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { fn } from "storybook/test";
import { ActivityControls } from "./ActivityControls";

const meta = {
  title: "Activities/ActivityControls",
  component: ActivityControls,
  decorators: [(Story) => <View style={{ width: 360, padding: 16 }}>{Story()}</View>],
  args: {
    activityTypes: ["cycling", "running"],
    activityType: "all",
    preset: "this-week",
    searching: false,
    canSelect: true,
    selectMode: false,
    selectedCount: 0,
    deletePending: false,
    mergePending: false,
    mergeEligible: false,
    mixedTypes: false,
    onActivityTypeChange: fn(),
    onPresetChange: fn(),
    onSelect: fn(),
    onCancelSelection: fn(),
    onDeleteSelected: fn(),
    onMergeSelected: fn(),
  },
} satisfies Meta<typeof ActivityControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SelectionMode: Story = {
  args: {
    selectMode: true,
    selectedCount: 2,
    mergeEligible: true,
  },
};
