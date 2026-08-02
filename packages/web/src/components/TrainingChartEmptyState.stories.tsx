import type { Meta, StoryObj } from "@storybook/react-vite";
import { TrainingChartEmptyState } from "./TrainingChartEmptyState";

const meta = {
  title: "Charts/TrainingChartEmptyState",
  component: TrainingChartEmptyState,
  args: {
    availability: {
      status: "insufficient_data",
      sourceLabel: "Running activity sensor summaries",
      observedCount: 0,
      minimumCount: 1,
      message:
        "No running pace data is available from Running activity sensor summaries. Record at least 1 running activity with pace data to show this chart.",
    },
  },
} satisfies Meta<typeof TrainingChartEmptyState>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const PartialData: Story = {
  args: {
    availability: {
      status: "insufficient_data",
      sourceLabel: "Daily strain model",
      observedCount: 1,
      minimumCount: 2,
      message:
        "No daily strain trend is available from the daily strain model. Record at least 2 training days to show this chart.",
    },
  },
};

export const LongMessage: Story = {
  args: {
    availability: {
      status: "available",
      sourceLabel:
        "Cycling Zone 2 power and heart-rate summaries from the selected training history",
      observedCount: 12,
      minimumCount: 1,
      message:
        "Aerobic efficiency data is available from the selected cycling Zone 2 power and heart-rate summaries across the full training history.",
    },
  },
};
