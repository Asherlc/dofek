import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { TIME_RANGE_OPTIONS, type TimeRangeDays } from "../lib/timeRange.ts";
import { TimeRangeSelector } from "./TimeRangeSelector";

function TimeRangeSelectorStory({ initialDays }: { initialDays: TimeRangeDays }) {
  const [days, setDays] = useState<TimeRangeDays>(initialDays);
  return (
    <div className="inline-flex flex-col gap-3">
      <TimeRangeSelector
        days={days}
        description="Recommended default: 90 days balances recent training changes with enough history."
        onChange={setDays}
      />
      <span className="text-sm text-muted">
        Selected: {TIME_RANGE_OPTIONS.find((option) => option.days === days)?.label}
      </span>
    </div>
  );
}

const meta = {
  title: "Components/TimeRangeSelector",
  component: TimeRangeSelectorStory,
  tags: ["autodocs"],
  args: {
    initialDays: 30,
  },
} satisfies Meta<typeof TimeRangeSelectorStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AllSelected: Story = {
  args: {
    initialDays: null,
  },
};

export const OneYearSelected: Story = {
  args: {
    initialDays: 365,
  },
};
