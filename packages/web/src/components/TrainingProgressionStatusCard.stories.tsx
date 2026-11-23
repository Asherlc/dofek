import type { Meta, StoryObj } from "@storybook/react-vite";
import { TrainingProgressionStatusCard } from "./TrainingProgressionStatusCard.tsx";

const meta = {
  title: "Training/TrainingProgressionStatusCard",
  component: TrainingProgressionStatusCard,
  args: {
    status: "ready",
    headline: "Bench press · Barbell",
    summary: "More reps at the same weight",
  },
} satisfies Meta<typeof TrainingProgressionStatusCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const Stagnating: Story = {
  args: {
    status: "stagnating",
    headline: "Squat · Barbell",
    summary: "Estimated strength held steady across 7 comparable sessions.",
  },
};
export const NoBadge: Story = { args: { status: null } };
export const WithEvidence: Story = {
  args: {
    details: <p className="text-xs text-muted">Nov 20, 2026 · 60 kg · 10 reps · whoop</p>,
    action: (
      <a className="text-accent" href="/training/strength">
        See strength evidence
      </a>
    ),
  },
};
