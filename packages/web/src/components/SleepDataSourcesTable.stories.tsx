import type { Meta, StoryObj } from "@storybook/react-vite";
import { type SleepDataSourceRow, SleepDataSourcesTable } from "./SleepDataSourcesTable.tsx";

const firstRow: SleepDataSourceRow = {
  date: "2026-07-24",
  durationMinutes: 452,
  providerId: "apple_health",
  sourceName: "Apple Watch",
  sourceProviders: ["apple_health", "whoop"],
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

export const Default: Story = {};
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = { args: { rows: [] } };
export const MissingDuration: Story = {
  args: {
    rows: [{ ...firstRow, durationMinutes: null }],
  },
};
