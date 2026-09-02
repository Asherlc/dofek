import type { Meta, StoryObj } from "@storybook/react-vite";
import { MacroBar } from "./MacroBar";

const meta = {
  title: "Nutrition/MacroBar",
  component: MacroBar,
  tags: ["autodocs"],
  args: {
    label: "Protein",
    grams: 65,
    energySharePercentage: 25,
    color: "blue",
  },
} satisfies Meta<typeof MacroBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Protein: Story = {};

export const Carbs: Story = {
  args: {
    label: "Carbs",
    grams: 107.5,
    energySharePercentage: 42,
    color: "purple",
  },
};

export const Fat: Story = {
  args: {
    label: "Fat",
    grams: 340 / 9,
    energySharePercentage: 33,
    color: "teal",
  },
};
