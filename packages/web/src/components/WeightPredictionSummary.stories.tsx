import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WeightPrediction } from "../../../server/src/routers/body-analytics.ts";
import { UnitContext } from "../lib/unitContext.ts";
import { WeightPredictionSummary } from "./WeightPredictionSummary";

function makePrediction(overrides: Partial<WeightPrediction> = {}): WeightPrediction {
  return {
    ratePerWeek: -0.3,
    rateConfidence: 0.92,
    impliedDailyCalories: -330,
    periodDeltas: { days7: -0.3, days14: -0.6, days30: -1.3 },
    goal: null,
    projectionLine: [],
    ...overrides,
  };
}

const meta = {
  title: "Body/WeightPredictionSummary",
  component: WeightPredictionSummary,
  tags: ["autodocs"],
  args: {
    prediction: makePrediction(),
  },
} satisfies Meta<typeof WeightPredictionSummary>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Losing: Story = {};

export const Gaining: Story = {
  args: {
    prediction: makePrediction({
      ratePerWeek: 0.4,
      impliedDailyCalories: 440,
      periodDeltas: { days7: 0.4, days14: 0.8, days30: 1.7 },
    }),
  },
};

export const Stable: Story = {
  args: {
    prediction: makePrediction({
      ratePerWeek: 0.02,
      impliedDailyCalories: 22,
      periodDeltas: { days7: 0.02, days14: 0.04, days30: 0.1 },
    }),
  },
};

export const WithGoalOnTrack: Story = {
  args: {
    prediction: makePrediction({
      goal: {
        goalWeightKg: 75,
        remainingKg: -5,
        estimatedDate: "2026-07-15",
        daysRemaining: 100,
      },
    }),
  },
};

export const WithGoalTrendingAway: Story = {
  args: {
    prediction: makePrediction({
      ratePerWeek: 0.3,
      impliedDailyCalories: 330,
      periodDeltas: { days7: 0.3, days14: 0.6, days30: 1.3 },
      goal: {
        goalWeightKg: 75,
        remainingKg: -5,
        estimatedDate: null,
        daysRemaining: null,
      },
    }),
  },
};

export const MinimalData: Story = {
  args: {
    prediction: makePrediction({
      periodDeltas: { days7: -0.2, days14: null, days30: null },
    }),
  },
};

export const Imperial: Story = {
  args: {
    prediction: makePrediction({
      goal: {
        goalWeightKg: 75,
        remainingKg: -5,
        estimatedDate: "2026-07-15",
        daysRemaining: 100,
      },
    }),
  },
  decorators: [
    (Story) => (
      <UnitContext.Provider value={{ unitSystem: "imperial", setUnitSystem: () => {} }}>
        <Story />
      </UnitContext.Provider>
    ),
  ],
};
