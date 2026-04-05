import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  SmoothedWeightRow,
  WeightPrediction,
} from "../../../server/src/routers/body-analytics.ts";
import { UnitContext } from "../lib/unitContext.ts";
import { SmoothedWeightChart } from "./SmoothedWeightChart";

function generateWeightData(
  startKg: number,
  days: number,
  trendPerDay: number,
): SmoothedWeightRow[] {
  const rows: SmoothedWeightRow[] = [];
  let smoothed = startKg;
  for (let index = 0; index < days; index++) {
    const date = new Date(2026, 2, 1 + index).toISOString().slice(0, 10);
    const noise = (Math.sin(index * 0.7) + Math.cos(index * 1.3)) * 0.4;
    const raw = startKg + trendPerDay * index + noise;
    smoothed = index === 0 ? raw : 0.1 * raw + 0.9 * smoothed;
    rows.push({
      date,
      rawWeight: Math.round(raw * 100) / 100,
      smoothedWeight: Math.round(smoothed * 100) / 100,
      weeklyChange: index >= 7 ? Math.round(trendPerDay * 7 * 100) / 100 : null,
      interpolated: false,
    });
  }
  return rows;
}

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
  title: "Body/SmoothedWeightChart",
  component: SmoothedWeightChart,
  tags: ["autodocs"],
  args: {
    data: generateWeightData(84, 90, -0.03),
  },
} satisfies Meta<typeof SmoothedWeightChart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Imperial: Story = {
  decorators: [
    (Story) => (
      <UnitContext.Provider value={{ unitSystem: "imperial", setUnitSystem: () => {} }}>
        <Story />
      </UnitContext.Provider>
    ),
  ],
};

export const GainingWeight: Story = {
  args: {
    data: generateWeightData(78, 60, 0.05),
  },
};

export const Loading: Story = {
  args: {
    loading: true,
  },
};

export const Empty: Story = {
  args: {
    data: [],
  },
};

export const WithGoalWeight: Story = {
  args: {
    data: generateWeightData(84, 90, -0.03),
    prediction: makePrediction({
      goal: {
        goalWeightKg: 80,
        remainingKg: -1.3,
        estimatedDate: "2026-07-15",
        daysRemaining: 43,
      },
      projectionLine: Array.from({ length: 30 }, (_, index) => ({
        date: new Date(2026, 4, 31 + index).toISOString().slice(0, 10),
        projectedWeight: Math.round((81.3 - 0.03 * index) * 100) / 100,
      })),
    }),
  },
};

export const TrendingAwayFromGoal: Story = {
  args: {
    data: generateWeightData(78, 60, 0.05),
    prediction: makePrediction({
      ratePerWeek: 0.35,
      goal: {
        goalWeightKg: 75,
        remainingKg: -6,
        estimatedDate: null,
        daysRemaining: null,
      },
    }),
  },
};
