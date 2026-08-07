import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { ActivitySourceDecisionCard } from "./ActivitySourceDecisionCard";

const meta = {
  title: "Activity/ActivitySourceDecisionCard",
  component: ActivitySourceDecisionCard,
  args: {
    decision: {
      sourceCount: 2,
      primarySourceLabel: "Wahoo",
      explanation:
        "Wahoo was selected as the primary record by source priority. Missing details may come from the other matched sources.",
    },
  },
  decorators: [
    (Story) => (
      <View style={{ padding: 16 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ActivitySourceDecisionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MultiSource: Story = {
  name: "Conflicting sources",
  tags: ["review-scenario", "review-scenario-conflicting-sources"],
};

export const ThreeSources: Story = {
  args: {
    decision: {
      sourceCount: 3,
      primarySourceLabel: "Strong (via Apple Health)",
      explanation:
        "Strong (via Apple Health) was selected as the primary record by source priority. Missing details may come from the other matched sources.",
    },
  },
};
