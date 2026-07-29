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

export const Empty: Story = {
  tags: ["review-scenario", "review-scenario-empty-data"],
  args: {
    data: {
      current: null,
      history: [],
      emptyState: {
        reportKind: "monthly",
        title: "Your monthly report will appear here",
        message: "No activity, sleep, or recovery data is available for this report yet.",
        minimumObservedDays: 1,
        acceptedDataTypes: ["activity", "sleep", "recovery"],
        requirement:
          "At least 1 observed day of activity, sleep, or recovery data is required to create a monthly report.",
        previewTitle: "When ready, your monthly report will include",
        previewItems: [
          "Training time and activity count",
          "Average daily strain",
          "Average sleep duration",
          "Average resting heart rate",
          "Average heart rate variability",
          "Month-over-month training and sleep changes",
        ],
        note: "This preview shows report sections only. No personal values or conclusions are estimated.",
      },
    },
  },
};
