import type { Meta, StoryObj } from "@storybook/react-vite";
import { createReportEmptyState } from "dofek-server/report-empty-state";
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
        avgDailyLoad: 450,
        avgReadiness: 75,
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
          avgDailyLoad: 420,
          avgReadiness: 72,
        },
      ],
      decisionSupport: {
        whatChanged: [
          "Training was 8.5 hours, 13.3% more than the previous week.",
          "Average nightly sleep was 7 hours 30 minutes, 20 minutes more than the previous week.",
        ],
        likelyAssociations: [
          "Higher training coincided with more sleep and higher heart rate variability this week. This is a descriptive association, not evidence that one change caused another.",
        ],
        whatWorked: [
          "You completed 6 activities while sleep and heart rate variability were stable or improved.",
        ],
        whatToTryNext: [
          "Keep one major input steady next week—training volume or sleep schedule—so the following comparison is easier to interpret.",
        ],
        confidenceAndMissingData: [
          "Confidence is limited because only 2 weekly periods are available.",
          "These period averages can show co-movement, but they cannot establish cause and effect.",
        ],
      },
      emptyState: createReportEmptyState("weekly"),
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

export const Empty: Story = {
  tags: ["review-scenario", "review-scenario-empty-data"],
  args: {
    data: {
      current: null,
      history: [],
      decisionSupport: null,
      emptyState: createReportEmptyState("weekly"),
    },
  },
};
