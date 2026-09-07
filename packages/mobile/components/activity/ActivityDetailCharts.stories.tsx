import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { AreaChart, CHART_COLORS, LineChart } from "./ActivityDetailCharts";

const meta = {
  title: "Activity/ActivityDetailCharts",
  component: LineChart,
  args: {
    data: [{ value: 112 }, { value: 125 }, { value: 138 }, { value: 129 }],
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
  args: { data: [{ value: 112 }, { value: null }, { value: 138 }, { value: 129 }] },
};
export const Area: Story = { render: (args) => <AreaChart {...args} /> };
