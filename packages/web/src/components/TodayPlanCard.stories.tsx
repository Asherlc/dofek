import type { TodayPlanResult } from "@dofek/scoring/today-plan";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TodayPlanCard } from "./TodayPlanCard.tsx";

const readyPlan: TodayPlanResult = {
  status: "ready",
  date: "2026-07-26",
  action: {
    id: "strain_target",
    title: "Train hard today — aim for 16.2 strain",
    summary: "Recovery is strong (82). Push for a high-strain day to build fitness.",
    zone: "Push",
  },
  supportingFacts: [
    { label: "Recovery", value: "82/100" },
    { label: "Sleep performance", value: "88 (Good)" },
  ],
  caveats: [],
  confidence: "high",
  freshness: {
    recoveryDate: "2026-07-26",
    sleepDate: "2026-07-26",
  },
  missingInputs: [],
};

const insufficientPlan: TodayPlanResult = {
  status: "insufficient_data",
  date: "2026-07-26",
  action: null,
  supportingFacts: [],
  confidence: "low",
  freshness: {
    recoveryDate: null,
    sleepDate: null,
  },
  missingInputs: ["recovery"],
  message:
    "Connect a recovery source and wait for today's recovery score before a training plan can be generated.",
};

const noChangePlan: TodayPlanResult = {
  ...readyPlan,
  action: {
    id: "strain_target",
    title: "No change needs attention — aim for 12 strain",
    summary: "Moderate recovery (60). Aim for a steady training day.",
    zone: "Maintain",
  },
  supportingFacts: [
    { label: "Recovery", value: "60/100" },
    { label: "Sleep performance", value: "82 (Good)" },
  ],
  confidence: "moderate",
};

const meta = {
  title: "Components/TodayPlanCard",
  component: TodayPlanCard,
  args: {
    plan: readyPlan,
  },
} satisfies Meta<typeof TodayPlanCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Ready: Story = {};

export const NoChangeNeedsAttention: Story = {
  args: {
    plan: noChangePlan,
  },
};

export const InsufficientData: Story = {
  args: {
    plan: insufficientPlan,
  },
};

export const Loading: Story = {
  args: {
    plan: undefined,
    loading: true,
  },
};

export const ErrorState: Story = {
  args: {
    plan: undefined,
    error: new Error("Today plan unavailable"),
  },
};
