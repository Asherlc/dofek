import { formatGrams } from "@dofek/format/format";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { MacroBar } from "./MacroBar";

const meta = {
  title: "Nutrition/MacroBar",
  component: MacroBar,
  tags: ["autodocs"],
  args: {
    label: "Protein",
    grams: formatGrams(150),
    percentage: 30,
    color: "blue",
  },
} satisfies Meta<typeof MacroBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Protein: Story = {};

export const Carbs: Story = {
  args: {
    label: "Carbs",
    grams: formatGrams(250),
    percentage: 50,
    color: "amber",
  },
};

export const Fat: Story = {
  args: {
    label: "Fat",
    grams: formatGrams(44),
    percentage: 20,
    color: "red",
  },
};
