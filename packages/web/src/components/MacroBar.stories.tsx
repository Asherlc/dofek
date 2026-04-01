import type { Meta, StoryObj } from "@storybook/react-vite";
import { MacroBar } from "./MacroBar";

const meta = {
  title: "Nutrition/MacroBar",
  component: MacroBar,
  tags: ["autodocs"],
  args: {
    label: "Protein",
    grams: 150,
    caloriesFromMacro: 600,
    totalCalories: 2000,
    color: "blue",
  },
} satisfies Meta<typeof MacroBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Protein: Story = {};

export const Carbs: Story = {
  args: {
    label: "Carbs",
    grams: 250,
    caloriesFromMacro: 1000,
    totalCalories: 2000,
    color: "amber",
  },
};

export const Fat: Story = {
  args: {
    label: "Fat",
    grams: 44,
    caloriesFromMacro: 400,
    totalCalories: 2000,
    color: "red",
  },
};
