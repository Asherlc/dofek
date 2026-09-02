import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WorkloadRatioRow } from "dofek-server/types";
import { WorkloadRatioChart } from "./WorkloadRatioChart.tsx";

const workload: WorkloadRatioRow[] = [
  {
    date: "2026-05-25",
    dailyLoad: 72,
    strain: 8.2,
    acuteLoad: 48,
    chronicLoad: 44,
    workloadRatio: 1.09,
  },
  {
    date: "2026-05-26",
    dailyLoad: 0,
    strain: 0,
    acuteLoad: 43,
    chronicLoad: 44.2,
    workloadRatio: 0.97,
  },
  {
    date: "2026-05-27",
    dailyLoad: 86,
    strain: 9.4,
    acuteLoad: 51,
    chronicLoad: 45,
    workloadRatio: 1.13,
  },
  {
    date: "2026-05-28",
    dailyLoad: 34,
    strain: 5.1,
    acuteLoad: 52,
    chronicLoad: 45.4,
    workloadRatio: 1.15,
  },
  {
    date: "2026-05-29",
    dailyLoad: 96,
    strain: 10.2,
    acuteLoad: 61,
    chronicLoad: 46.6,
    workloadRatio: 1.31,
  },
  {
    date: "2026-05-30",
    dailyLoad: 0,
    strain: 0,
    acuteLoad: 55,
    chronicLoad: 46.8,
    workloadRatio: 1.18,
  },
  {
    date: "2026-05-31",
    dailyLoad: 58,
    strain: 7.1,
    acuteLoad: 57,
    chronicLoad: 47.2,
    workloadRatio: 1.21,
  },
];

const meta = {
  title: "Recovery/WorkloadRatioChart",
  component: WorkloadRatioChart,
  tags: ["autodocs"],
  args: {
    data: workload,
    context: {
      label: "Recent-to-baseline workload ratio",
      description:
        "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days.",
      recentDays: 7,
      baselineDays: 28,
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkloadRatioChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
export const HigherRecentLoad: Story = {
  args: {
    data: workload.map((row, index) => ({
      ...row,
      acuteLoad: 70 + index * 4,
      chronicLoad: 45 + index,
      workloadRatio: 1.55 + index * 0.05,
    })),
  },
};
