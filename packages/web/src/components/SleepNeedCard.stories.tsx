import type { Meta, StoryObj } from "@storybook/react-vite";
import { MISSING_PREVIOUS_NIGHT_MESSAGE, type SleepNeedV2 } from "dofek-server/sleep-need-contract";
import { SleepNeedCard } from "./SleepNeedCard";

const emptyProvenance: Pick<
  Extract<SleepNeedV2, { availability: "available" }>["recentNights"][number],
  "providerId" | "sourceName" | "sourceProviders"
> = {
  providerId: null,
  sourceName: null,
  sourceProviders: [],
};

const sampleData = {
  availability: "available",
  epistemicStatus: { kind: "estimated", label: "Estimated" },
  baselineMinutes: 462,
  strainDebtMinutes: 12,
  accumulatedDebtMinutes: 85,
  debtRecoveryMinutes: 21,
  totalNeedMinutes: 483,
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
  recentNights: [
    {
      date: "2026-03-27",
      actualMinutes: 488,
      neededMinutes: 462,
      debtMinutes: 0,
      ...emptyProvenance,
    },
    {
      date: "2026-03-28",
      actualMinutes: 505,
      neededMinutes: 462,
      debtMinutes: 0,
      ...emptyProvenance,
    },
    {
      date: "2026-03-29",
      actualMinutes: 473,
      neededMinutes: 462,
      debtMinutes: 0,
      ...emptyProvenance,
    },
    {
      date: "2026-03-30",
      actualMinutes: 454,
      neededMinutes: 462,
      debtMinutes: 8,
      ...emptyProvenance,
    },
    {
      date: "2026-03-31",
      actualMinutes: 481,
      neededMinutes: 462,
      debtMinutes: 0,
      ...emptyProvenance,
    },
    {
      date: "2026-04-01",
      actualMinutes: null,
      neededMinutes: 462,
      debtMinutes: null,
      ...emptyProvenance,
    },
    {
      date: "2026-04-02",
      actualMinutes: 510,
      neededMinutes: 462,
      debtMinutes: 0,
      ...emptyProvenance,
    },
  ],
} satisfies SleepNeedV2;

const meta = {
  title: "Sleep/SleepNeedCard",
  component: SleepNeedCard,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div style={{ width: 400 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    data: sampleData,
  },
} satisfies Meta<typeof SleepNeedCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const HighDebt: Story = {
  args: {
    data: {
      ...sampleData,
      accumulatedDebtMinutes: 240,
      totalNeedMinutes: 540,
      recentNights: sampleData.recentNights.map((night) =>
        night.actualMinutes ? { ...night, actualMinutes: 380, debtMinutes: 82 } : night,
      ),
    },
  },
};

export const CannotRecommend: Story = {
  args: {
    data: {
      availability: "missing_previous_night",
      epistemicStatus: { kind: "unavailable", label: "Unavailable" },
      message: MISSING_PREVIOUS_NIGHT_MESSAGE,
    },
  },
};

export const Loading: Story = {
  args: { loading: true },
};

export const NoData: Story = {
  args: { data: undefined },
};
