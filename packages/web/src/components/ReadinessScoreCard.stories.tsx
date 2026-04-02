import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReadinessScoreCard } from "./ReadinessScoreCard";

const meta = {
  title: "Recovery/ReadinessScoreCard",
  component: ReadinessScoreCard,
  tags: ["autodocs"],
  args: {
    data: [
      {
        date: "2026-03-25",
        readinessScore: 65,
        components: {
          hrvScore: 60,
          restingHrScore: 70,
          sleepScore: 65,
          respiratoryRateScore: 80,
        },
      },
      {
        date: "2026-03-31",
        readinessScore: 92,
        components: {
          hrvScore: 90,
          restingHrScore: 95,
          sleepScore: 92,
          respiratoryRateScore: 94,
        },
      },
    ],
  },
} satisfies Meta<typeof ReadinessScoreCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    loading: true,
  },
};
