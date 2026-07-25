import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SleepNightlyRow } from "dofek-server/types";
import { SleepAnalyticsChart } from "./SleepAnalyticsChart.tsx";

const nightly: SleepNightlyRow[] = [
  {
    date: "2026-05-25",
    durationMinutes: 470,
    sleepMinutes: 432,
    deepPct: 22,
    remPct: 24,
    lightPct: 46,
    awakePct: 8,
    efficiency: 92,
    rollingAvgDuration: 425,
  },
  {
    date: "2026-05-26",
    durationMinutes: 445,
    sleepMinutes: 401,
    deepPct: 19,
    remPct: 23,
    lightPct: 48,
    awakePct: 10,
    efficiency: 90,
    rollingAvgDuration: 421,
  },
  {
    date: "2026-05-27",
    durationMinutes: 495,
    sleepMinutes: 457,
    deepPct: 24,
    remPct: 25,
    lightPct: 43,
    awakePct: 8,
    efficiency: 92,
    rollingAvgDuration: 429,
  },
  {
    date: "2026-05-28",
    durationMinutes: 430,
    sleepMinutes: 387,
    deepPct: 18,
    remPct: 21,
    lightPct: 51,
    awakePct: 10,
    efficiency: 90,
    rollingAvgDuration: 423,
  },
  {
    date: "2026-05-29",
    durationMinutes: 480,
    sleepMinutes: 446,
    deepPct: 23,
    remPct: 24,
    lightPct: 46,
    awakePct: 7,
    efficiency: 93,
    rollingAvgDuration: 431,
  },
];

const meta = {
  title: "Sleep/SleepAnalyticsChart",
  component: SleepAnalyticsChart,
  tags: ["autodocs"],
  args: { nightly, sleepDebt: 96 },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SleepAnalyticsChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { nightly: [], sleepDebt: null, loading: true } };
export const Empty: Story = { args: { nightly: [], sleepDebt: null } };
export const SleepSurplus: Story = { args: { sleepDebt: -72 } };
