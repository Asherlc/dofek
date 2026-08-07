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
      sodium_mg: 640,
      potassium_mg: 520,
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
      fiber_g: 4,
      sugar_g: 19,
    },
  },
};

export const Deleting: Story = {
  args: {
    deleting: true,
  },
};

export const DetailedNutrition: Story = {
  args: {
    entry: {
      id: "3",
      food_name: "Chicken Bowl",
      food_description: "1 bowl",
      meal: "lunch",
      calories: 420,
      protein_g: 32,
      carbs_g: 41.5,
      fat_g: 12,
      saturated_fat_g: 3.5,
      sodium_mg: 680,
      vitamin_c_mg: 18,
      iron_mg: 3.2,
    },
  },
};
