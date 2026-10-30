import type { Meta, StoryObj } from "@storybook/react";
import { ScrollView } from "react-native";
import { fn } from "storybook/test";
import { ActivityClimbingPanel } from "./ActivityClimbingPanel";
import { climbingLogFixture, exactClimbingLocation } from "./climbing-log-entry-fixtures";

const entries = [
  climbingLogFixture,
  { ...climbingLogFixture, id: "repeat" },
  { ...climbingLogFixture, id: "indoor", climb: null, title: "Indoor board log" },
];
const meta = {
  title: "Activity/Climbing layout",
  component: ActivityClimbingPanel,
  args: {
    entries,
    locations: { [climbingLogFixture.id]: exactClimbingLocation, repeat: exactClimbingLocation },
  },
  decorators: [
    (Story) => (
      <ScrollView style={{ maxWidth: 430 }} contentContainerStyle={{ padding: 16 }}>
        <Story />
      </ScrollView>
    ),
  ],
} satisfies Meta<typeof ActivityClimbingPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const GroupedListAndMap: Story = {};
export const ApproximateArea: Story = {
  args: {
    locations: {
      [climbingLogFixture.id]: { ...exactClimbingLocation, scope: "area", name: "Goat Rock" },
      repeat: { ...exactClimbingLocation, scope: "area", name: "Goat Rock" },
    },
  },
};
export const Empty: Story = { args: { entries: [], locations: {} } };
export const NoLocations: Story = { args: { locations: {} } };

export const WithAttachmentSuggestions: Story = {
  args: {
    suggestions: [{ ...climbingLogFixture, id: "suggestion" }],
    locations: { ...meta.args.locations, suggestion: exactClimbingLocation },
    onAttach: fn(),
    attachmentStates: {
      suggestion: {
        pending: false,
        error: "Refresh this activity and try attaching this entry again.",
      },
    },
  },
};
export const SuggestionsOnly: Story = {
  args: { entries: [], suggestions: [climbingLogFixture], onAttach: fn() },
};
