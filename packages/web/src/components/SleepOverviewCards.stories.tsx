import type { Meta, StoryObj } from "@storybook/react-vite";
import { MISSING_PREVIOUS_NIGHT_MESSAGE } from "dofek-server/sleep-need-contract";
import { SleepOverviewCards } from "./SleepOverviewCards";

const availableSleepNeed = {
  availability: "available" as const,
  baselineMinutes: 480,
  strainDebtMinutes: 12,
  accumulatedDebtMinutes: 85,
  debtRecoveryMinutes: 21,
  totalNeedMinutes: 513,
  recentNights: [],
};

const sleepPerformance = {
  score: 88,
  tier: "Good" as const,
  actualMinutes: 462,
  neededMinutes: 480,
  efficiency: 92,
  recommendedBedtime: "10:30 PM",
  sleepDate: "2026-04-02",
  providerId: "whoop",
  sourceName: "WHOOP 4.0",
  sourceProviders: ["whoop"],
};

const meta = {
  title: "Sleep/SleepOverviewCards",
  component: SleepOverviewCards,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div style={{ width: "100%", maxWidth: 900 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    sleepNeed: availableSleepNeed,
    sleepPerformance,
  },
} satisfies Meta<typeof SleepOverviewCards>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    sleepNeed: undefined,
    sleepNeedLoading: true,
    sleepPerformance: undefined,
    sleepPerformanceLoading: true,
  },
};

export const NoData: Story = {
  args: {
    sleepNeed: undefined,
    sleepPerformance: null,
  },
};

export const SleepDataNeeded: Story = {
  args: {
    sleepNeed: {
      availability: "missing_previous_night",
      message: MISSING_PREVIOUS_NIGHT_MESSAGE,
    },
    sleepPerformance: null,
  },
};
