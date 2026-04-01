import type { Meta, StoryObj } from "@storybook/react-vite";
import { WeeklyReportCard } from "./WeeklyReportCard";

const meta = {
  title: "Insights/WeeklyReportCard",
  component: WeeklyReportCard,
  tags: ["autodocs"],
  args: {
    data: {
      current: {
        weekStart: "2026-03-30",
        trainingHours: 8.5,
        activityCount: 6,
        avgSleepMinutes: 450,
        sleepPerformancePct: 92,
        avgRestingHr: 52,
        avgHrv: 65,
        strainZone: "maintain",
      },
      history: [
        {
          weekStart: "2026-03-23",
          trainingHours: 7.5,
          activityCount: 5,
          avgSleepMinutes: 430,
          sleepPerformancePct: 90,
          avgRestingHr: 53,
          avgHrv: 62,
          strainZone: "maintain",
        },
      ],
    },
  },
} satisfies Meta<typeof WeeklyReportCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    loading: true,
  },
};
