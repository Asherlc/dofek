import type { Meta, StoryObj } from "@storybook/react-vite";
import { RecordedDailyMetrics } from "./RecordedDailyMetrics.tsx";

const meta = {
  title: "Components/RecordedDailyMetrics",
  component: RecordedDailyMetrics,
} satisfies Meta<typeof RecordedDailyMetrics>;
export default meta;
type Story = StoryObj<typeof meta>;

const intervals = { providerId: "intervals.icu", sourceName: null };

export const IntervalsIcuBodyAndSleep: Story = {
  args: {
    rows: [
      { ...intervals, date: "2026-03-02", metric: "weight", value: 70.4, unit: "kg" },
      { ...intervals, date: "2026-03-02", metric: "resting_heart_rate", value: 52, unit: "bpm" },
      {
        ...intervals,
        date: "2026-03-01",
        metric: "sleep_duration_reported",
        value: 27000,
        unit: "s",
      },
    ],
  },
};

export const OtherProviderNoDisclosure: Story = {
  args: {
    rows: [
      {
        date: "2026-03-02",
        metric: "weight",
        value: 70.4,
        unit: "kg",
        providerId: "withings",
        sourceName: null,
      },
    ],
  },
};
