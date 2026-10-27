import type { Meta, StoryObj } from "@storybook/react-vite";
import { SleepPerformanceCard } from "./SleepPerformanceCard";

const sampleProvenance = {
  providerId: "whoop",
  sourceName: "WHOOP 4.0",
  sourceProviders: ["whoop"],
};

const meta = {
  title: "Sleep/SleepPerformanceCard",
  component: SleepPerformanceCard,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div style={{ width: 400 }}>
        <Story />
      </div>
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
      summaryDateContext: { effectiveDate: "2026-04-02", timezone: "UTC" },
      ...sampleProvenance,
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
      summaryDateContext: { effectiveDate: "2026-04-02", timezone: "UTC" },
      ...sampleProvenance,
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
      summaryDateContext: { effectiveDate: "2026-04-02", timezone: "UTC" },
      providerId: "apple_health",
      sourceName: "Apple Watch",
      sourceProviders: ["apple_health", "whoop"],
    },
  },
};

export const Loading: Story = {
  args: { loading: true },
};

export const NoData: Story = {
  args: { data: null },
};
