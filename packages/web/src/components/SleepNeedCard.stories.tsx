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
  availability: "available" as const,
  baselineMinutes: 462,
  strainDebtMinutes: 12,
  accumulatedDebtMinutes: 85,
  debtRecoveryMinutes: 21,
  totalNeedMinutes: 483,
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
};

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
