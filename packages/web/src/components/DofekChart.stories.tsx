import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DofekChart } from "./DofekChart";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const meta = {
  title: "Charts/DofekChart",
  component: DofekChart,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <div style={{ width: 600 }}>
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
  args: {
    option: {
      xAxis: { type: "category", data: ["Mon", "Tue", "Wed", "Thu", "Fri"] },
      yAxis: { type: "value" },
      series: [{ type: "bar", data: [120, 200, 150, 80, 170] }],
    },
    height: 250,
  },
} satisfies Meta<typeof DofekChart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: { loading: true },
};

export const Empty: Story = {
  args: { empty: true },
};

export const EmptyCustomMessage: Story = {
  args: { empty: true, emptyMessage: "No sleep data yet" },
};

export const CustomHeight: Story = {
  args: { height: 400 },
};
