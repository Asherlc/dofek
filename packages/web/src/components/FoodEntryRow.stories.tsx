import type { FoodEntryNutrientDetail } from "@dofek/nutrition/food-entry-nutrition";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { FoodEntryRow } from "./FoodEntryRow";

const nutrientDetails: FoodEntryNutrientDetail[] = [
  {
    id: "calories",
    label: "Calories",
    amount: 420,
    unit: "kcal",
    category: "macro",
    sortOrder: 1,
    valueText: "420 kcal",
  },
  {
    id: "protein",
    label: "Protein",
    amount: 32,
    unit: "g",
    category: "macro",
    sortOrder: 2,
    valueText: "32 g",
  },
  {
    id: "carbohydrate",
    label: "Carbohydrates",
    amount: 41.5,
    unit: "g",
    category: "macro",
    sortOrder: 3,
    valueText: "41.5 g",
  },
  {
    id: "sodium",
    label: "Sodium",
    amount: 680,
    unit: "mg",
    category: "other_macro",
    sortOrder: 201,
    valueText: "680 mg",
  },
];

const meta = {
  title: "Nutrition/FoodEntryRow",
  component: FoodEntryRow,
  args: {
    foodName: "Chicken Bowl",
    servingDescription: "1 bowl",
    calories: 420,
    nutrients: nutrientDetails,
    onDelete: () => undefined,
    deleting: false,
  },
} satisfies Meta<typeof FoodEntryRow>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NoDescription: Story = {
  args: {
    servingDescription: null,
  },
};

export const NoNutrients: Story = {
  args: {
    nutrients: [],
  },
};

export const Deleting: Story = {
  args: {
    deleting: true,
  },
};
