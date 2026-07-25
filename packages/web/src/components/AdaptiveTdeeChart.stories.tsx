import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AdaptiveTdeeResult } from "../../../server/src/routers/nutrition-analytics.ts";
import { UnitContext } from "../lib/unitContext.ts";
import { AdaptiveTdeeChart } from "./AdaptiveTdeeChart.tsx";

const data: AdaptiveTdeeResult = {
  estimatedTdee: 2380,
  confidence: 0.82,
  dataPoints: 28,
  dailyData: [
    {
      date: "2026-07-20",
      caloriesIn: 2260,
      weightKg: 78.4,
      smoothedWeight: 78.5,
      estimatedTdee: 2340,
    },
    {
      date: "2026-07-21",
      caloriesIn: 2410,
      weightKg: 78.3,
      smoothedWeight: 78.4,
      estimatedTdee: 2365,
    },
    {
      date: "2026-07-22",
      caloriesIn: 2325,
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
export const Empty: Story = {
  args: {
    data: { estimatedTdee: null, confidence: 0, dataPoints: 0, dailyData: [] },
  },
};
