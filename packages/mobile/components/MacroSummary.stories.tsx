import type { Meta, StoryObj } from "@storybook/react-native";
import { MacroSummary } from "./MacroSummary";

const meta = {
  title: "Nutrition/MacroSummary",
  component: MacroSummary,
  args: {
    calories: 1250,
    calorieGoal: { target: 2000, remaining: 750, over: 0, progressPercentage: 62.5 },
    macros: {
      protein: { grams: 110, calories: 440, energySharePercentage: 31 },
      carbs: { grams: 140, calories: 560, energySharePercentage: 40 },
      fat: { grams: 45, calories: 405, energySharePercentage: 29 },
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
      protein: { grams: 20, calories: 80, energySharePercentage: 28 },
      carbs: { grams: 40, calories: 160, energySharePercentage: 56 },
      fat: { grams: 5, calories: 45, energySharePercentage: 16 },
    },
  },
};

export const GoalReached: Story = {
  args: {
    calories: 2100,
    calorieGoal: { target: 2000, remaining: 0, over: 100, progressPercentage: 100 },
    macros: {
      protein: { grams: 160, calories: 640, energySharePercentage: 31 },
      carbs: { grams: 220, calories: 880, energySharePercentage: 43 },
      fat: { grams: 60, calories: 540, energySharePercentage: 26 },
    },
  },
};

export const AuditRoundingCase: Story = {
  args: {
    calories: 1000,
    calorieGoal: { target: 2000, remaining: 1000, over: 0, progressPercentage: 50 },
    macros: {
      protein: { grams: 65, calories: 260, energySharePercentage: 25 },
      carbs: { grams: 107.5, calories: 430, energySharePercentage: 42 },
      fat: { grams: 340 / 9, calories: 340, energySharePercentage: 33 },
    },
  },
};
