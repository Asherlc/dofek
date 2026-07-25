import type { Meta, StoryObj } from "@storybook/react-vite";
import { MonthlyReportContent } from "./MonthlyReportContent.tsx";

const meta = {
  title: "Reports/MonthlyReportContent",
  component: MonthlyReportContent,
  args: {
    data: {
      current: {
        monthStart: "2026-07-01",
        trainingHours: 20,
        activityCount: 10,
        avgDailyStrain: 8,
        avgSleepMinutes: 450,
        avgRestingHr: 55,
        avgHrv: 48,
        trainingHoursTrend: 10,
        avgSleepTrend: -2,
      },
      history: [],
    },
  },
} satisfies Meta<typeof MonthlyReportContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
