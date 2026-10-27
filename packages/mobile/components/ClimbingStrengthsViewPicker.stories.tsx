import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { View } from "react-native";
import { ClimbingStrengthsViewPicker } from "./ClimbingStrengthsViewPicker";

const meta = {
  title: "Components/ClimbingStrengthsViewPicker",
  component: ClimbingStrengthsViewPicker,
  args: {
    value: "gaps",
    onChange: () => {},
    compareSettings: false,
    onCompareSettingsChange: () => {},
  },
  decorators: [
    (Story) => (
      <View style={{ padding: 16 }}>
        <Story />
      </View>
    ),
  ],
  render: function ViewPickerStory(args) {
    const [value, setValue] = useState(args.value);
    const [compareSettings, setCompareSettings] = useState(args.compareSettings);
    return (
      <ClimbingStrengthsViewPicker
        {...args}
        value={value}
        onChange={setValue}
        compareSettings={compareSettings}
        onCompareSettingsChange={setCompareSettings}
      />
    );
  },
} satisfies Meta<typeof ClimbingStrengthsViewPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const StyleGaps: Story = { args: { value: "gaps" } };
export const SuccessCurves: Story = { args: { value: "curves" } };
export const ExposureMap: Story = { args: { value: "exposure" } };
export const GradePyramids: Story = { args: { value: "pyramids" } };
export const Progress: Story = { args: { value: "progress" } };
export const RadarProfile: Story = { args: { value: "radar" } };
