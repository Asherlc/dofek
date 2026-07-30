import type { Meta, StoryObj } from "@storybook/react-vite";
import { type SleepDataSourceRow, SleepDataSourcesTable } from "./SleepDataSourcesTable.tsx";

const firstRow: SleepDataSourceRow = {
  date: "2026-07-24",
  durationMinutes: 452,
  providerId: "apple_health",
  sourceName: "Apple Watch",
  sourceProviders: ["apple_health", "whoop"],
  selectedSessionId: "00000000-0000-4000-8000-000000001774",
  startedAt: "2026-07-25T06:00:00Z",
  endedAt: "2026-07-25T13:32:00Z",
  localTimeContext: {
    timezone: "America/Los_Angeles",
    startUtcOffsetMinutes: -420,
    endUtcOffsetMinutes: -420,
    source: "provider_timezone",
  },
  overlappingSessions: [
    {
      sessionId: "00000000-0000-4000-8000-000000001775",
      providerId: "oura",
      sourceName: "Oura Ring",
      sourceProviders: ["oura"],
      localTimeContext: {
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        source: "provider_timezone",
      },
      startedAt: "2026-07-25T07:30:00Z",
      endedAt: "2026-07-25T12:55:00Z",
      durationMinutes: 325,
    },
  ],
  stagingAvailable: true,
};

const rows: SleepDataSourceRow[] = [
  firstRow,
  {
    date: "2026-07-23",
    durationMinutes: 418,
    providerId: "whoop",
    sourceName: null,
    sourceProviders: ["whoop"],
    selectedSessionId: "00000000-0000-4000-8000-000000001773",
    startedAt: "2026-07-24T05:50:00Z",
    endedAt: "2026-07-24T12:48:00Z",
    localTimeContext: {
      timezone: "America/Los_Angeles",
      startUtcOffsetMinutes: -420,
      endUtcOffsetMinutes: -420,
      source: "provider_timezone",
    },
    overlappingSessions: [],
    stagingAvailable: false,
  },
];

const meta = {
  title: "Sleep/SleepDataSourcesTable",
  component: SleepDataSourcesTable,
  args: { rows },
} satisfies Meta<typeof SleepDataSourcesTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  name: "Conflicting sources",
  tags: ["review-scenario", "review-scenario-conflicting-sources"],
};
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = { args: { rows: [] } };
export const MissingDuration: Story = {
  args: {
    rows: [{ ...firstRow, durationMinutes: null }],
  },
};
