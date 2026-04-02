import type { Meta, StoryObj } from "@storybook/react-native";
import { MetricCard } from "./MetricCard";

const meta = {
  title: "Components/MetricCard",
  component: MetricCard,
  args: {
    title: "Heart Rate",
    value: "65",
    unit: "bpm",
    trend: [60, 62, 68, 64, 65, 63, 65],
    color: "#ff453a",
    subtitle: "Avg last 7 days",
  },
} satisfies Meta<typeof MetricCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithTrendUp: Story = {
  args: {
    title: "Steps",
    value: "12,403",
    unit: "",
    trend: [8000, 9000, 11000, 10500, 12000, 12403],
    trendDirection: "up",
    color: "#32d74b",
  },
};

export const Stable: Story = {
  args: {
    title: "Weight",
    value: "75.2",
    unit: "kg",
    trend: [75.1, 75.3, 75.2, 75.2, 75.2],
    trendDirection: "stable",
    color: "#0a84ff",
  },
};

export const Simple: Story = {
  args: {
    trend: undefined,
    subtitle: undefined,
  },
};
