import type { Meta, StoryObj } from "@storybook/react-native";
import { MealSection } from "./MealSection";

const meta = {
  title: "Nutrition/MealSection",
  component: MealSection,
  args: {
    mealName: "Breakfast",
    mealKey: "breakfast",
    entries: [
      {
        id: "1",
        food_name: "Oatmeal",
        food_description: "1 cup with berries",
        meal: "breakfast",
        calories: 350,
        protein_g: 12,
        carbs_g: 65,
        fat_g: 6,
      },
      {
        id: "2",
        food_name: "Protein Shake",
        food_description: "Whey isolate",
        meal: "breakfast",
        calories: 120,
        protein_g: 25,
        carbs_g: 2,
        fat_g: 1,
      },
    ],
    onAddFood: (mealKey: string) => void mealKey,
    onDeleteFood: (id: string) => void id,
    deleting: false,
  },
} satisfies Meta<typeof MealSection>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    entries: [],
  },
};

export const Deleting: Story = {
  args: {
    deleting: true,
  },
};
