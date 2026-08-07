import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { NutritionDataQualityPanel } from "./NutritionDataQualityPanel";

const meta = {
  title: "Nutrition/NutritionDataQualityPanel",
  component: NutritionDataQualityPanel,
  args: {
    dataQuality: {
      selectedWindowDays: 30,
      daysWithData: 24,
      usableDays: 22,
      overlapDays: 3,
      conflictDays: 2,
      completenessPercent: 73.3,
      sourceLabels: ["Cronometer", "Manual"],
      contributingSourceLabels: ["Manual"],
      excludedSourceLabels: ["Cronometer"],
    },
  },
  decorators: [
    (Story) => (
      <View style={{ padding: 16, width: 360 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof NutritionDataQualityPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PartialWithOverlap: Story = {};
export const Loading: Story = {
  args: {
    loading: true,
  },
};
export const Complete: Story = {
  args: {
    dataQuality: {
      selectedWindowDays: 30,
      daysWithData: 30,
      usableDays: 30,
      overlapDays: 0,
      conflictDays: 0,
      completenessPercent: 100,
      sourceLabels: ["Manual"],
      contributingSourceLabels: ["Manual"],
      excludedSourceLabels: [],
    },
  },
};
export const Empty: Story = {
  args: {
    dataQuality: {
      selectedWindowDays: 30,
      daysWithData: 0,
      usableDays: 0,
      overlapDays: 0,
      conflictDays: 0,
      completenessPercent: 0,
      sourceLabels: [],
      contributingSourceLabels: [],
      excludedSourceLabels: [],
    },
  },
};
