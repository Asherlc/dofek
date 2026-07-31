import type { Meta, StoryObj } from "@storybook/react-vite";
import { MonthlyReportContent } from "./MonthlyReportContent.tsx";
import { monthlyReportEmptyStateFixture } from "./report-empty-state-fixtures.ts";

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
      emptyState: monthlyReportEmptyStateFixture,
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
      emptyState: monthlyReportEmptyStateFixture,
      recovery: {
        range: { startDate: "2026-03-01", endDate: "2026-03-24" },
        emptyMessage:
          "No activity, sleep, or recovery data was found from 2026-03-01 through 2026-03-24.",
      },
    },
  },
};
