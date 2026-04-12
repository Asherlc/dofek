import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { HeartRateChart } from "./HeartRateChart";

function generateHeartRateData(count: number, base: number, variance: number): number[] {
  const data: number[] = [];
  let current = base;
  for (let index = 0; index < count; index++) {
    current += (Math.random() - 0.5) * variance;
    current = Math.max(40, Math.min(200, current));
    data.push(Math.round(current));
  }
  return data;
}

const meta = {
  title: "Charts/HeartRateChart",
  component: HeartRateChart,
  decorators: [
    (Story) => (
      <View style={{ padding: 16, backgroundColor: "#f5f7f2" }}>
        <Story />
      </View>
    ),
  ],
  args: {
    data: generateHeartRateData(60, 72, 6),
    width: 340,
    height: 180,
  },
} satisfies Meta<typeof HeartRateChart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Resting: Story = {
  args: {
    data: generateHeartRateData(60, 62, 4),
  },
};

export const Exercise: Story = {
  args: {
    data: generateHeartRateData(120, 155, 10),
  },
};

export const WarmingUp: Story = {
  args: {
    data: Array.from({ length: 90 }, (_, index) =>
      Math.round(65 + (index / 90) * 80 + (Math.random() - 0.5) * 8),
    ),
  },
};

export const FewDataPoints: Story = {
  args: {
    data: [68, 72, 70],
  },
};
