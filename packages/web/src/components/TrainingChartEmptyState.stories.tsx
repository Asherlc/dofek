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
