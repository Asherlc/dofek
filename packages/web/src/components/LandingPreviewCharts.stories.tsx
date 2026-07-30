import { activityMetricColors } from "@dofek/scoring/colors";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { LandingPreviewLineChart, LandingPreviewScatterPlot } from "./LandingPreviewCharts.tsx";

const meta = {
  title: "Components/LandingPreviewCharts",
  component: LandingPreviewScatterPlot,
  tags: ["autodocs"],
  args: {
    accessibleName: "Example correlation scatter plot",
    xAxisLabel: "Sleep consistency (%)",
    xTickLabels: ["70", "100"],
    yAxisLabel: "Heart rate variability (ms)",
    yTickLabels: ["45", "85"],
  },
} satisfies Meta<typeof LandingPreviewScatterPlot>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Scatter: Story = {};

export const Trend: Story = {
  render: () => (
    <LandingPreviewLineChart
      accessibleName="Example resting heart rate trend"
      color={activityMetricColors.heartRate}
      endLabel="May 27"
      startLabel="May 21"
      yAxisLabel="Resting heart rate (bpm)"
      yTickLabels={["48", "56"]}
    />
  ),
};
