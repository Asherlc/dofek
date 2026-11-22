import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { RecordedDailyMetrics } from "./RecordedDailyMetrics";

const intervals = { providerId: "intervals.icu", sourceName: null };

const meta = {
  title: "Body/RecordedDailyMetrics",
  component: RecordedDailyMetrics,
  decorators: [(Story) => <View style={{ width: 360, padding: 16 }}>{Story()}</View>],
} satisfies Meta<typeof RecordedDailyMetrics>;

export default meta;
type Story = StoryObj<typeof meta>;

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
