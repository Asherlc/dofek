import type { TodayPlanResult } from "@dofek/scoring/today-plan";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TodayPlanCard } from "./TodayPlanCard.tsx";

const readyPlan: TodayPlanResult = {
  status: "ready",
  epistemicStatus: { kind: "suggested", label: "Suggested" },
  date: "2026-07-26",
  action: {
    id: "strain_target",
    title: "Suggested strain: 16.2",
    zone: "Push",
  },
  supportingFacts: [
    { label: "Recovery", value: "82/100" },
    { label: "Sleep performance", value: "88 (Good)" },
  ],
  caveats: [],
  freshness: {
    recoveryDate: "2026-07-26",
    sleepDate: "2026-07-26",
  },
  missingInputs: [],
};

const insufficientPlan: TodayPlanResult = {
  status: "insufficient_data",
  epistemicStatus: { kind: "unavailable", label: "Unavailable" },
  date: "2026-07-26",
  action: null,
  supportingFacts: [],
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
    title: "Suggested strain: 12",
    zone: "Maintain",
  },
  supportingFacts: [
    { label: "Recovery", value: "60/100" },
    { label: "Sleep performance", value: "82 (Good)" },
  ],
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
