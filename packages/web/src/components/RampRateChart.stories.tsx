import type { Meta, StoryObj } from "@storybook/react-vite";
import type { RampRateWeek } from "dofek-server/types";
import { RampRateChart } from "./RampRateChart.tsx";

const weeks: RampRateWeek[] = [
  { week: "2026-04-27", ctlStart: 42, ctlEnd: 44.5, rampRate: 2.5 },
  { week: "2026-05-04", ctlStart: 44.5, ctlEnd: 48.2, rampRate: 3.7 },
  { week: "2026-05-11", ctlStart: 48.2, ctlEnd: 54.4, rampRate: 6.2 },
  { week: "2026-05-18", ctlStart: 54.4, ctlEnd: 57.1, rampRate: 2.7 },
  { week: "2026-05-25", ctlStart: 57.1, ctlEnd: 61.3, rampRate: 4.2 },
];

const meta = {
  title: "Training/RampRateChart",
  component: RampRateChart,
  tags: ["autodocs"],
  args: {
    data: weeks,
    currentRampRate: 4.2,
    recommendation: "Productive build. Keep the next increase below 5 fitness points.",
  },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RampRateChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = {
  args: {
    data: [],
    currentRampRate: 0,
    recommendation: "Loading the latest training recommendation.",
    loading: true,
  },
};
export const Empty: Story = {
  args: { data: [], currentRampRate: 0, recommendation: "Log more training to establish a trend." },
};
export const AggressiveBuild: Story = {
  args: {
    currentRampRate: 7.4,
    recommendation: "Ramp rate is high. Hold or reduce load this week.",
    data: [
      ...weeks.slice(0, -1),
      { week: "2026-05-25", ctlStart: 57.1, ctlEnd: 64.5, rampRate: 7.4 },
    ],
  },
};
