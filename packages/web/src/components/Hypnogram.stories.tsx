import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Hypnogram } from "./Hypnogram";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const sampleStages = [
  { stage: "light", started_at: "2026-04-02T22:15:00Z", ended_at: "2026-04-02T22:45:00Z" },
  { stage: "deep", started_at: "2026-04-02T22:45:00Z", ended_at: "2026-04-02T23:30:00Z" },
  { stage: "light", started_at: "2026-04-02T23:30:00Z", ended_at: "2026-04-03T00:00:00Z" },
  { stage: "rem", started_at: "2026-04-03T00:00:00Z", ended_at: "2026-04-03T00:45:00Z" },
  { stage: "light", started_at: "2026-04-03T00:45:00Z", ended_at: "2026-04-03T01:30:00Z" },
  { stage: "deep", started_at: "2026-04-03T01:30:00Z", ended_at: "2026-04-03T02:15:00Z" },
  { stage: "awake", started_at: "2026-04-03T02:15:00Z", ended_at: "2026-04-03T02:25:00Z" },
  { stage: "light", started_at: "2026-04-03T02:25:00Z", ended_at: "2026-04-03T03:00:00Z" },
  { stage: "rem", started_at: "2026-04-03T03:00:00Z", ended_at: "2026-04-03T04:00:00Z" },
  { stage: "light", started_at: "2026-04-03T04:00:00Z", ended_at: "2026-04-03T05:00:00Z" },
  { stage: "deep", started_at: "2026-04-03T05:00:00Z", ended_at: "2026-04-03T05:30:00Z" },
  { stage: "light", started_at: "2026-04-03T05:30:00Z", ended_at: "2026-04-03T06:00:00Z" },
];

const meta = {
  title: "Sleep/Hypnogram",
  component: Hypnogram,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <div style={{ width: 700 }}>
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
  args: {
    data: sampleStages,
  },
} satisfies Meta<typeof Hypnogram>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: { loading: true },
};

export const NoStages: Story = {
  args: { data: [] },
};
