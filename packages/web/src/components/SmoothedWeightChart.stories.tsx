import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SmoothedWeightRow } from "../../../server/src/routers/body-analytics.ts";
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
    });
  }
  return rows;
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
