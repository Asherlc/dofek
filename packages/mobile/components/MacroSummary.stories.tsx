import type { Meta, StoryObj } from "@storybook/react-native";
import { MacroSummary } from "./MacroSummary";

const meta = {
  title: "Nutrition/MacroSummary",
  component: MacroSummary,
  args: {
    calories: 1250,
    calorieGoal: { target: 2000, remaining: 750, over: 0, progressPercentage: 62.5 },
    macros: {
      protein: { grams: 110, calories: 440, percentage: 35 },
      carbs: { grams: 140, calories: 560, percentage: 45 },
      fat: { grams: 45, calories: 405, percentage: 32 },
    },
  },
} satisfies Meta<typeof MacroSummary>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LowProgress: Story = {
  args: {
    calories: 300,
    calorieGoal: { target: 2000, remaining: 1700, over: 0, progressPercentage: 15 },
    macros: {
      protein: { grams: 20, calories: 80, percentage: 27 },
      carbs: { grams: 40, calories: 160, percentage: 53 },
      fat: { grams: 5, calories: 45, percentage: 15 },
    },
  },
};

export const GoalReached: Story = {
  args: {
    calories: 2100,
    calorieGoal: { target: 2000, remaining: 0, over: 100, progressPercentage: 100 },
    macros: {
      protein: { grams: 160, calories: 640, percentage: 30 },
      carbs: { grams: 220, calories: 880, percentage: 42 },
      fat: { grams: 60, calories: 540, percentage: 26 },
    },
  },
};
