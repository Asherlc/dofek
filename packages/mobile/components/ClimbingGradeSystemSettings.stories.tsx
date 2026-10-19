import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { View } from "react-native";
import { ClimbingGradeSystemSettings } from "./ClimbingGradeSystemSettings";

const meta = {
  title: "Settings/ClimbingGradeSystemSettings",
  component: ClimbingGradeSystemSettings,
  args: {
    errorMessage: null,
    onChange: () => {},
    preference: { boulder: "v_scale", route: "yds" },
    saving: false,
  },
  decorators: [
    (Story) => (
      <View style={{ padding: 16 }}>
        <Story />
      </View>
    ),
  ],
  render: (args) => {
    const [preference, setPreference] = useState(args.preference);
    return (
      <ClimbingGradeSystemSettings {...args} preference={preference} onChange={setPreference} />
    );
  },
} satisfies Meta<typeof ClimbingGradeSystemSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SavedPreference: Story = {
  args: { preference: { boulder: "font", route: "french" } },
};

export const Loading: Story = {
  args: { preference: null },
};

export const RefreshError: Story = {
  args: {
    errorMessage: "Your session expired. Sign in again to refresh your settings.",
  },
};

export const InitialError: Story = {
  args: {
    preference: null,
    errorMessage: "Your session expired. Sign in again to load your settings.",
  },
};

export const Saving: Story = {
  args: { saving: true },
};
