import type { Meta, StoryObj } from "@storybook/react-vite";
import { MISSING_PREVIOUS_NIGHT_MESSAGE, type SleepNeedV2 } from "dofek-server/sleep-need-contract";
import { SleepOverviewCards } from "./SleepOverviewCards";

const availableSleepNeed = {
  availability: "available",
  epistemicStatus: { kind: "estimated", label: "Estimated" },
  baselineMinutes: 480,
  strainDebtMinutes: 12,
  accumulatedDebtMinutes: 85,
  debtRecoveryMinutes: 21,
  totalNeedMinutes: 513,
  estimateMetadata: {
    basis: "personalized_high_hrv_average",
    baselineQualifyingNightCount: 12,
    debtObservedNightCount: 11,
    methodVersion: "sleep-need-heuristic-v1",
    uncertainty: "not_established",
    valueQualifier: "About",
    summaryLabel: "Heuristic estimate",
    componentLabels: {
      baseline: "Baseline estimate",
      strainDebt: "Previous-day load adjustment",
      debtRecovery: "Debt recovery",
    },
    basisLabel:
      "Baseline uses the average of 12 qualifying nights followed by at-or-above-median heart rate variability.",
    coverageLabel: "Sleep-debt input uses 11 observed nights from the model's recent-night window.",
    methodLabel: "Method: sleep-need-heuristic-v1",
    uncertaintyLabel: "Uncertainty: not established",
    limitationLabel:
      "This is a descriptive heuristic estimate, not a sleep recommendation. Its uncertainty has not been established.",
  },
  recentNights: [],
} satisfies SleepNeedV2;

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
  summaryDateContext: { effectiveDate: "2026-04-02", timezone: "UTC" },
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
      epistemicStatus: { kind: "unavailable", label: "Unavailable" },
      message: MISSING_PREVIOUS_NIGHT_MESSAGE,
    },
    sleepPerformance: null,
  },
};
