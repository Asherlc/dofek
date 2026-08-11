import type { Meta, StoryObj } from "@storybook/react-vite";
import type { HangboardingSummary as HangboardingSummaryData } from "../../../server/src/repositories/hangboarding-repository.ts";
import { HangboardingSummary } from "./HangboardingSummary.tsx";

const data: HangboardingSummaryData = {
  sessionCount: 4,
  totalDurationSeconds: 3120,
  averageDurationSeconds: 780,
  totalWorkDurationSeconds: 240,
  totalRestDurationSeconds: 1440,
  workIntervalCount: 24,
  averageHeartRate: 126,
  peakHeartRate: 154,
  latestSession: {
    activityId: "activity-2",
    startedAt: "2026-08-08T14:00:00.000Z",
    planName: "7/3 Repeaters",
    boardName: "Tension Board",
    durationSeconds: 840,
  },
  daily: [
    {
      date: "2026-08-05",
      sessionCount: 1,
      durationSeconds: 720,
      workDurationSeconds: 60,
      restDurationSeconds: 360,
    },
    {
      date: "2026-08-07",
      sessionCount: 2,
      durationSeconds: 1560,
      workDurationSeconds: 120,
      restDurationSeconds: 720,
    },
    {
      date: "2026-08-08",
      sessionCount: 1,
      durationSeconds: 840,
      workDurationSeconds: 60,
      restDurationSeconds: 360,
    },
  ],
};

const meta = {
  title: "Training/HangboardingSummary",
  component: HangboardingSummary,
  tags: ["autodocs"],
  args: { data, loading: false },
  decorators: [
    (Story) => (
      <div className="w-[720px] bg-page p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HangboardingSummary>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = { args: { data: undefined, loading: true } };

export const Empty: Story = {
  args: { data: { ...data, sessionCount: 0, daily: [], latestSession: null }, loading: false },
};
