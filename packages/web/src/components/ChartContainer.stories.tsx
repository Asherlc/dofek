import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChartContainer } from "./ChartContainer";

const meta = {
  title: "Charts/ChartContainer",
  component: ChartContainer,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div style={{ width: 600 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    loading: false,
    data: [1, 2, 3],
    children: (
      <div className="flex items-center justify-center h-full bg-surface rounded p-4">
        Chart content goes here
      </div>
    ),
  },
} satisfies Meta<typeof ChartContainer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithData: Story = {};

export const Loading: Story = {
  args: { loading: true },
};

export const Empty: Story = {
  args: { data: [] },
};

export const EmptyCustomMessage: Story = {
  args: { data: [], emptyMessage: "No activity data available" },
};

export const CustomHeight: Story = {
  args: { height: 400 },
};
