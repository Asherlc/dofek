import type { Meta, StoryObj } from "@storybook/react-native";
import { MacroSummary } from "./MacroSummary";

const meta = {
  title: "Nutrition/MacroSummary",
  component: MacroSummary,
  args: {
    calories: 1250,
    caloriesGoal: 2000,
    proteinGrams: 110,
    carbsGrams: 140,
    fatGrams: 45,
  },
} satisfies Meta<typeof MacroSummary>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LowProgress: Story = {
  args: {
    calories: 300,
    proteinGrams: 20,
    carbsGrams: 40,
    fatGrams: 5,
  },
};

export const GoalReached: Story = {
  args: {
    calories: 2100,
    proteinGrams: 160,
    carbsGrams: 220,
    fatGrams: 60,
  },
};
