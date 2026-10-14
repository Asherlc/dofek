import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { fn } from "storybook/test";
import { ClimbingEntryCard } from "./ClimbingEntryCard";
import {
  areaClimbingLocation,
  climbingEntryFixture,
  exactClimbingLocation,
} from "./climbing-entry-fixtures";

const meta = {
  title: "Climbing/Entry Card",
  component: ClimbingEntryCard,
  args: { entry: climbingEntryFixture },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <View style={{ width: "100%", maxWidth: 320 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ClimbingEntryCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const ExactClimb: Story = { args: { location: exactClimbingLocation } };
export const AreaLocation: Story = { args: { location: areaClimbingLocation } };
export const NotSent: Story = {
  args: {
    entry: {
      ...climbingEntryFixture,
      sent: false,
      attemptCount: null,
      ascentType: "Fell/Hung",
      context: { ...climbingEntryFixture.context, resultStyle: "Fell/Hung" },
    },
  },
};
export const LongName: Story = {
  args: {
    entry: {
      ...climbingEntryFixture,
      routeName:
        "A very long route name across the upper wall above the California coastal climbing area",
    },
    location: exactClimbingLocation,
  },
};
export const AttachPending: Story = {
  args: {
    location: exactClimbingLocation,
    onAttach: fn(),
    attachmentState: { pending: true, error: null },
  },
};
export const AttachError: Story = {
  args: {
    location: areaClimbingLocation,
    onAttach: fn(),
    attachmentState: {
      pending: false,
      error: "Refresh this activity and try attaching this entry again.",
    },
  },
};
