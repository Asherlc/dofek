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
      decisionSupport: {
        whatChanged: [
          "This is the first observed month, so month-over-month changes are not available yet.",
        ],
        likelyAssociations: [
          "No training-and-recovery association can be assessed yet because there is no comparison month with tracked sleep and recovery.",
        ],
        whatWorked: ["There is not enough history yet to identify a repeatable positive pattern."],
        whatToTryNext: [
          "Repeat or deliberately adjust one part of the routine next month, then compare it with this baseline.",
        ],
        confidenceAndMissingData: [
          "Confidence is low because only 1 monthly period is available.",
          "These period averages can show co-movement, but they cannot establish cause and effect.",
        ],
      },
      emptyState: {
        reportKind: "monthly",
        title: "Your monthly report will appear here",
        message: "No activity, sleep, or recovery data is available for this report yet.",
        minimumObservedDays: 1,
        acceptedDataTypes: ["activity", "sleep", "recovery"],
        requirement: "At least 1 observed day of activity, sleep, or recovery data is required to create a monthly report.",
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
      recovery: {
        range: { startDate: "2026-03-01", endDate: "2026-03-24" },
        emptyMessage: "No activity, sleep, or recovery data was found from 2026-03-01 through 2026-03-24.",
      },
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
      decisionSupport: null,
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
      recovery: {
        range: { startDate: "2026-03-01", endDate: "2026-03-24" },
        emptyMessage: "No activity, sleep, or recovery data was found from 2026-03-01 through 2026-03-24.",
      },
    },
  },
};
