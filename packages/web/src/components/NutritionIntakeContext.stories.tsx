import type { Meta, StoryObj } from "@storybook/react-vite";
import { NutritionIntakeContext } from "./NutritionIntakeContext";

const meta = {
  title: "Nutrition/NutritionIntakeContext",
  component: NutritionIntakeContext,
  tags: ["autodocs"],
} satisfies Meta<typeof NutritionIntakeContext>;

export default meta;

type Story = StoryObj<typeof meta>;

const limitation =
  "This target describes logged intake only; it is not an estimate of energy expenditure or calorie balance.";

export const Default: Story = {
  args: {
    context: {
      observedCalories: 1250,
      target: {
        calories: 2000,
        type: "configured",
        label: "Configured daily logged-intake target",
      },
      scale: { maximumCalories: 2000, observedPercentage: 62.5, targetPercentage: 100 },
      comparison: {
        status: "below_target",
        differenceCalories: 750,
        message:
          "Observed logged intake is 750 kcal below the configured daily logged-intake target.",
      },
      limitation,
    },
  },
};

export const UnderTarget: Story = Default;

export const NoLoggedIntake: Story = {
  args: {
    context: {
      observedCalories: 0,
      target: {
        calories: 2000,
        type: "default",
        label: "Default daily logged-intake target",
      },
      scale: { maximumCalories: 2000, observedPercentage: 0, targetPercentage: 100 },
      comparison: {
        status: "below_target",
        differenceCalories: 2000,
        message:
          "Observed logged intake is 2,000 kcal below the default daily logged-intake target.",
      },
      limitation,
    },
  },
};

export const AtTarget: Story = {
  args: {
    context: {
      observedCalories: 2000,
      target: {
        calories: 2000,
        type: "configured",
        label: "Configured daily logged-intake target",
      },
      scale: { maximumCalories: 2000, observedPercentage: 100, targetPercentage: 100 },
      comparison: {
        status: "at_target",
        differenceCalories: 0,
        message: "Observed logged intake matches the configured daily logged-intake target.",
      },
      limitation,
    },
  },
};

export const AboveTarget: Story = {
  args: {
    context: {
      observedCalories: 4259,
      target: {
        calories: 2450,
        type: "configured",
        label: "Configured daily logged-intake target",
      },
      scale: {
        maximumCalories: 4259,
        observedPercentage: 100,
        targetPercentage: 57.525240666823194,
      },
      comparison: {
        status: "above_target",
        differenceCalories: 1809,
        message:
          "Observed logged intake is 1,809 kcal above the configured daily logged-intake target.",
      },
      limitation,
    },
  },
};
