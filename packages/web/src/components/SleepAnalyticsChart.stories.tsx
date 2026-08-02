import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SleepNightlyRow } from "dofek-server/types";
import { SleepAnalyticsChart } from "./SleepAnalyticsChart.tsx";

const sourceEvidence = {
  providerId: null,
  sourceName: null,
  sourceProviders: [],
  selectedSessionId: null,
  overlappingSessions: [],
  durationState: { status: "available" as const },
  sleepState: { status: "available" as const },
  stageState: { status: "available" as const },
};

const nightly: SleepNightlyRow[] = [
  {
    ...sourceEvidence,
    date: "2026-05-25",
    startedAt: "2026-05-26T05:00:00Z",
    endedAt: "2026-05-26T12:50:00Z",
    localTimeContext: {
      timezone: "America/Los_Angeles",
      startUtcOffsetMinutes: -420,
      endUtcOffsetMinutes: -420,
      source: "provider_timezone",
    },
    durationMinutes: 470,
    sleepMinutes: 432,
    deepPct: 22,
    remPct: 24,
    lightPct: 46,
    awakePct: 8,
    efficiency: 92,
    stagingAvailable: true,
    rollingAvgDuration: 425,
  },
  {
    ...sourceEvidence,
    date: "2026-05-26",
    startedAt: "2026-05-27T05:15:00Z",
    endedAt: "2026-05-27T12:40:00Z",
    localTimeContext: {
      timezone: "America/Los_Angeles",
      startUtcOffsetMinutes: -420,
      endUtcOffsetMinutes: -420,
      source: "provider_timezone",
    },
    durationMinutes: 445,
    sleepMinutes: 401,
    deepPct: 19,
    remPct: 23,
    lightPct: 48,
    awakePct: 10,
    efficiency: 90,
    stagingAvailable: true,
    rollingAvgDuration: 421,
  },
  {
    ...sourceEvidence,
    date: "2026-05-27",
    startedAt: "2026-05-28T04:45:00Z",
    endedAt: "2026-05-28T13:00:00Z",
    localTimeContext: {
      timezone: "America/Los_Angeles",
      startUtcOffsetMinutes: -420,
      endUtcOffsetMinutes: -420,
      source: "provider_timezone",
    },
    durationMinutes: 495,
    sleepMinutes: 457,
    deepPct: 24,
    remPct: 25,
    lightPct: 43,
    awakePct: 8,
    efficiency: 92,
    stagingAvailable: true,
    rollingAvgDuration: 429,
  },
  {
    ...sourceEvidence,
    date: "2026-05-28",
    startedAt: "2026-05-29T05:30:00Z",
    endedAt: "2026-05-29T12:40:00Z",
    localTimeContext: {
      timezone: "America/Los_Angeles",
      startUtcOffsetMinutes: -420,
      endUtcOffsetMinutes: -420,
      source: "provider_timezone",
    },
    durationMinutes: 430,
    sleepMinutes: 387,
    deepPct: 18,
    remPct: 21,
    lightPct: 51,
    awakePct: 10,
    efficiency: 90,
    stagingAvailable: true,
    rollingAvgDuration: 423,
  },
  {
    ...sourceEvidence,
    date: "2026-05-29",
    startedAt: "2026-05-30T05:00:00Z",
    endedAt: "2026-05-30T13:00:00Z",
    localTimeContext: {
      timezone: "America/Los_Angeles",
      startUtcOffsetMinutes: -420,
      endUtcOffsetMinutes: -420,
      source: "provider_timezone",
    },
    durationMinutes: 480,
    sleepMinutes: 446,
    deepPct: 23,
    remPct: 24,
    lightPct: 46,
    awakePct: 7,
    efficiency: 93,
    stagingAvailable: true,
    rollingAvgDuration: 431,
  },
];

const referenceNight = nightly[0];
if (!referenceNight) {
  throw new Error("SleepAnalyticsChart stories require a reference night.");
}

const unavailableNight: SleepNightlyRow = {
  ...referenceNight,
  durationMinutes: null,
  sleepMinutes: null,
  deepPct: null,
  remPct: null,
  lightPct: null,
  awakePct: null,
  efficiency: null,
  stagingAvailable: false,
  rollingAvgDuration: null,
  durationState: {
    status: "missing",
    reason: "Sleep duration was not recorded.",
    nextAction: "Sync sleep data from a source that reports sleep duration.",
  },
  sleepState: {
    status: "missing",
    reason: "Sleep duration was not recorded.",
    nextAction: "Sync sleep data from a source that reports sleep duration.",
  },
  stageState: {
    status: "missing",
    reason: "Sleep stages were not reported for this night.",
    nextAction: "Sync sleep data from a source that reports sleep stages.",
  },
};

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
export const Unavailable: Story = { args: { nightly: [unavailableNight], sleepDebt: 0 } };
export const SleepSurplus: Story = { args: { sleepDebt: -72 } };
