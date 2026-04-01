import type { Meta, StoryObj } from "@storybook/react-native";
import { FoodEntryCard } from "./FoodEntryCard";

const meta = {
  title: "Nutrition/FoodEntryCard",
  component: FoodEntryCard,
  args: {
    entry: {
      id: "1",
      food_name: "Grilled Chicken Breast",
      food_description: "150g, seasoned",
      meal: "lunch",
      calories: 245,
      protein_g: 46,
      carbs_g: 0,
      fat_g: 5,
    },
    onDelete: (id: string) => void id,
    deleting: false,
  },
} satisfies Meta<typeof FoodEntryCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NoDescription: Story = {
  args: {
    entry: {
      id: "2",
      food_name: "Apple",
      food_description: null,
      meal: "snack",
      calories: 95,
      protein_g: 0,
      carbs_g: 25,
      fat_g: 0,
    },
  },
};

export const Deleting: Story = {
  args: {
    deleting: true,
  },
};
