import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SleepPerformanceCard } from "./SleepPerformanceCard";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const meta = {
  title: "Sleep/SleepPerformanceCard",
  component: SleepPerformanceCard,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <div style={{ width: 400 }}>
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
  args: {
    data: {
      score: 88,
      tier: "Good" as const,
      actualMinutes: 462,
      neededMinutes: 480,
      efficiency: 92,
      recommendedBedtime: "10:30 PM",
      sleepDate: "2026-04-02",
    },
  },
} satisfies Meta<typeof SleepPerformanceCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Good: Story = {};

export const Excellent: Story = {
  args: {
    data: {
      score: 96,
      tier: "Excellent",
      actualMinutes: 510,
      neededMinutes: 480,
      efficiency: 95,
      recommendedBedtime: "10:15 PM",
      sleepDate: "2026-04-02",
    },
  },
};

export const Poor: Story = {
  args: {
    data: {
      score: 42,
      tier: "Poor",
      actualMinutes: 320,
      neededMinutes: 480,
      efficiency: 72,
      recommendedBedtime: "9:30 PM",
      sleepDate: "2026-04-02",
    },
  },
};

export const Loading: Story = {
  args: { loading: true },
};

export const NoData: Story = {
  args: { data: null },
};
