import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { AreaChart, CHART_COLORS, LineChart } from "./ActivityDetailCharts";

const meta = {
  title: "Activity/ActivityDetailCharts",
  component: LineChart,
  args: {
    data: [
      { recordedAt: "2026-10-04T16:52:51.440Z", value: 112 },
      { recordedAt: "2026-10-04T16:53:51.440Z", value: 125 },
      { recordedAt: "2026-10-04T16:54:51.440Z", value: 138 },
      { recordedAt: "2026-10-04T16:55:51.440Z", value: 129 },
    ],
    color: CHART_COLORS.heartRate,
    label: "Heart rate",
    unit: "bpm",
  },
  decorators: [
    (Story) => (
      <View style={{ padding: 16 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof LineChart>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { data: [] } };
export const MissingSamples: Story = {
  args: {
    data: meta.args.data.map((sample, index) => ({
      ...sample,
      value: index === 1 ? null : sample.value,
    })),
  },
};
export const Area: Story = { render: (args) => <AreaChart {...args} /> };
