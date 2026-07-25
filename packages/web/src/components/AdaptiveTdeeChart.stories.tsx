import type { Meta, StoryObj } from "@storybook/react-vite";
import { AdaptiveTdeeChart } from "./AdaptiveTdeeChart";

const meta = {
  title: "Charts/AdaptiveTdeeChart",
  component: AdaptiveTdeeChart,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div style={{ width: 720 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AdaptiveTdeeChart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithEstimate: Story = {
  args: {
    data: {
      estimatedTdee: 2_250,
      confidence: 0.82,
      dataPoints: 30,
      dailyData: [
        {
          date: "2026-07-20",
          caloriesIn: 2_100,
          weightKg: 75,
          smoothedWeight: 74.9,
          estimatedTdee: 2_220,
        },
        {
          date: "2026-07-21",
          caloriesIn: 2_250,
          weightKg: 74.8,
          smoothedWeight: 74.8,
          estimatedTdee: 2_250,
        },
      ],
    },
  },
};

export const NeedsMoreData: Story = {
  args: {
    data: undefined,
  },
};
