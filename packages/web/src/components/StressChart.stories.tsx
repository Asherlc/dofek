import { formatDateYmd } from "@dofek/format/format";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { StressResult } from "dofek-server/types";
import { StressChart } from "./StressChart.tsx";

const storyToday = new Date();

function storyDate(daysAgo: number): string {
  const date = new Date(storyToday);
  date.setDate(storyToday.getDate() - daysAgo);
  return formatDateYmd(date);
}

const stableStress: StressResult = {
  daily: [
    {
      date: storyDate(6),
      stressScore: 1.1,
      hrvDeviation: -0.2,
      restingHrDeviation: 0.3,
      sleepEfficiency: 91,
    },
    {
      date: storyDate(5),
      stressScore: 0.8,
      hrvDeviation: 0.1,
      restingHrDeviation: -0.1,
      sleepEfficiency: 93,
    },
    {
      date: storyDate(4),
      stressScore: 1.4,
      hrvDeviation: -0.6,
      restingHrDeviation: 0.5,
      sleepEfficiency: 87,
    },
    {
      date: storyDate(3),
      stressScore: 1,
      hrvDeviation: -0.1,
      restingHrDeviation: 0.2,
      sleepEfficiency: 90,
    },
    {
      date: storyDate(2),
      stressScore: 0.7,
      hrvDeviation: 0.4,
      restingHrDeviation: -0.2,
      sleepEfficiency: 94,
    },
    {
      date: storyDate(1),
      stressScore: 1.2,
      hrvDeviation: -0.3,
      restingHrDeviation: 0.4,
      sleepEfficiency: 89,
    },
    {
      date: storyDate(0),
      stressScore: 0.9,
      hrvDeviation: 0,
      restingHrDeviation: 0.1,
      sleepEfficiency: 92,
    },
  ],
  weekly: [
    { weekStart: storyDate(7), cumulativeStress: 8.1, avgDailyStress: 1.16, highStressDays: 1 },
    { weekStart: storyDate(0), cumulativeStress: 7, avgDailyStress: 1, highStressDays: 0 },
  ],
  latestScore: 0.9,
  trend: "stable",
};

const meta = {
  title: "Recovery/StressChart",
  component: StressChart,
  tags: ["autodocs"],
  args: { data: stableStress },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StressChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { data: undefined, loading: true } };
export const Empty: Story = {
  args: { data: { daily: [], weekly: [], latestScore: null, trend: "stable" } },
};
export const Worsening: Story = {
  args: {
    data: {
      ...stableStress,
      latestScore: 2.7,
      trend: "worsening",
      daily: stableStress.daily.map((day, index) => ({
        ...day,
        stressScore: Math.min(3, 1.2 + index * 0.25),
      })),
    },
  },
};
