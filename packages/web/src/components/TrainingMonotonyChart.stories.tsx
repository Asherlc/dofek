import type { Meta, StoryObj } from "@storybook/react-vite";
import type { TrainingMonotonyWeek } from "dofek-server/types";
import { TrainingMonotonyChart } from "./TrainingMonotonyChart.tsx";

const method = {
  formula:
    "Monotony = 7-day mean daily cycling load ÷ population standard deviation of daily cycling load. Strain = weekly cycling load × monotony.",
  calendar: "Monday–Sunday calendar weeks include zero-load days.",
  activityScope: "Cycling activities with computed endurance training load.",
  interpretation:
    "These are descriptive workload-variability summaries, not an overtraining diagnosis.",
  source: {
    title: "Foster (1998), Monitoring training in athletes",
    url: "https://pubmed.ncbi.nlm.nih.gov/9662690/",
  },
};

const weeks: TrainingMonotonyWeek[] = [
  {
    week: "2026-04-27",
    monotony: 1.1,
    strain: 1_120,
    weeklyLoad: 1_018,
    dailyMeanLoad: 145.43,
    dailyLoadStandardDeviation: 132.21,
    method,
  },
  {
    week: "2026-05-04",
    monotony: 1.35,
    strain: 1_420,
    weeklyLoad: 1_052,
    dailyMeanLoad: 150.29,
    dailyLoadStandardDeviation: 111.32,
    method,
  },
  {
    week: "2026-05-11",
    monotony: 2.18,
    strain: 2_460,
    weeklyLoad: 1_128,
    dailyMeanLoad: 161.14,
    dailyLoadStandardDeviation: 73.92,
    method,
  },
  {
    week: "2026-05-18",
    monotony: 1.52,
    strain: 1_760,
    weeklyLoad: 1_158,
    dailyMeanLoad: 165.43,
    dailyLoadStandardDeviation: 108.83,
    method,
  },
  {
    week: "2026-05-25",
    monotony: 1.28,
    strain: 1_510,
    weeklyLoad: 1_180,
    dailyMeanLoad: 168.57,
    dailyLoadStandardDeviation: 131.7,
    method,
  },
];

const meta = {
  title: "Training/TrainingMonotonyChart",
  component: TrainingMonotonyChart,
  tags: ["autodocs"],
  args: { data: weeks },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TrainingMonotonyChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
export const IncreasingMonotony: Story = {
  args: {
    data: weeks.map((week, index) => {
      const monotony = 1.1 + index * 0.12;
      const dailyMeanLoad = week.weeklyLoad / 7;

      return {
        ...week,
        monotony,
        strain: week.weeklyLoad * monotony,
        dailyMeanLoad,
        dailyLoadStandardDeviation: dailyMeanLoad / monotony,
      };
    }),
  },
};
