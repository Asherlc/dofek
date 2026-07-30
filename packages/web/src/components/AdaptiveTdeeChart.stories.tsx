import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AdaptiveTdeeResult } from "../../../server/src/routers/nutrition-analytics.ts";
import { UnitContext } from "../lib/unitContext.ts";
import { AdaptiveTdeeChart } from "./AdaptiveTdeeChart.tsx";

const data: AdaptiveTdeeResult = {
  status: "available",
  estimatedTdee: 2380,
  estimateRange: { minimum: 2_340, maximum: 2_420 },
  unavailableReason: null,
  evidence: {
    selectedWindowDays: 90,
    fitWindowDays: 28,
    minimumCalorieDays: 20,
    observedDays: 90,
    calorieDays: 84,
    weightDays: 56,
    acceptedWindows: 28,
    excludedDays: {
      missingCalories: 4,
      sourceConflict: 2,
      lowerPrioritySources: 3,
    },
  },
  dailyData: [
    {
      date: "2026-07-20",
      caloriesIn: 2260,
      nutritionStatus: "available",
      lowerPrioritySourcesExcluded: false,
      weightKg: 78.4,
      smoothedWeight: 78.5,
      estimatedTdee: 2340,
    },
    {
      date: "2026-07-21",
      caloriesIn: 2410,
      nutritionStatus: "available",
      lowerPrioritySourcesExcluded: false,
      weightKg: 78.3,
      smoothedWeight: 78.4,
      estimatedTdee: 2365,
    },
    {
      date: "2026-07-22",
      caloriesIn: 2325,
      nutritionStatus: "available",
      lowerPrioritySourcesExcluded: false,
      weightKg: 78.2,
      smoothedWeight: 78.3,
      estimatedTdee: 2380,
    },
  ],
};

const meta = {
  title: "Nutrition/AdaptiveTdeeChart",
  component: AdaptiveTdeeChart,
  args: { data },
  decorators: [
    (Story) => (
      <UnitContext.Provider value={{ unitSystem: "metric", setUnitSystem: () => {} }}>
        <div className="w-[760px] p-4">
          <Story />
        </div>
      </UnitContext.Provider>
    ),
  ],
} satisfies Meta<typeof AdaptiveTdeeChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { data: undefined, loading: true } };
export const Unavailable: Story = {
  args: {
    data: {
      status: "unavailable",
      estimatedTdee: null,
      estimateRange: null,
      unavailableReason: "No body-weight measurements are available in the selected period.",
      evidence: {
        ...data.evidence,
        weightDays: 0,
        acceptedWindows: 0,
      },
      dailyData: [],
    },
  },
};
