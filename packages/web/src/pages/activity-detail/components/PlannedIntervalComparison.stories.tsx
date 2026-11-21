import type { Meta, StoryObj } from "@storybook/react-vite";
import { PlannedIntervalComparison } from "./PlannedIntervalComparison.tsx";

const range = {
  intervalIndex: 0,
  startOffsetSeconds: 0,
  endOffsetSeconds: 180,
  label: "Work 1",
  target: { kind: "range" as const, minWatts: 250, maxWatts: 265 },
  plannedDurationSeconds: 180,
  recordedTimerDurationSeconds: 180,
  timerDifferenceSeconds: 0,
  averagePowerWatts: 256,
};

const meta = {
  title: "Pages/ActivityDetail/PlannedIntervalComparison",
  component: PlannedIntervalComparison,
} satisfies Meta<typeof PlannedIntervalComparison>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Matched: Story = {
  args: {
    rows: [
      range,
      {
        ...range,
        intervalIndex: 1,
        startOffsetSeconds: 180,
        endOffsetSeconds: 360,
        label: "Work 2",
        recordedTimerDurationSeconds: 134,
        timerDifferenceSeconds: -46,
        averagePowerWatts: 242,
      },
      {
        ...range,
        intervalIndex: 2,
        startOffsetSeconds: 360,
        endOffsetSeconds: 540,
        label: "Work 3",
        target: { kind: "point", watts: 260 },
        averagePowerWatts: 260,
      },
      { ...range, intervalIndex: 3, label: "Work 4", averagePowerWatts: null },
    ],
  },
};
export const NoEligibleRows: Story = { args: { rows: [] } };
