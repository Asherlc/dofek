import { PRIMARY_GOAL_OPTIONS, type PrimaryGoal } from "@dofek/onboarding/primary-goal";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

/**
 * Storybook-only presentational stand-in for PrimaryGoalSelector.
 * The real component depends on tRPC hooks which aren't available in Storybook.
 */
function PrimaryGoalSelectorPreview({ initialGoal }: { initialGoal: PrimaryGoal | null }) {
  const [currentGoal, setCurrentGoal] = useState<PrimaryGoal | null>(initialGoal);

  return (
    <section className="space-y-3 w-[420px] p-4">
      <div>
        <h2 className="text-sm font-medium text-foreground">Primary goal</h2>
        <p className="text-xs text-subtle mt-0.5">
          Choose the outcome Dofek should optimize toward. You can change this anytime.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {PRIMARY_GOAL_OPTIONS.map((option) => {
          const isSelected = currentGoal === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setCurrentGoal(option.id)}
              aria-pressed={isSelected}
              className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${
                isSelected
                  ? "border-accent bg-accent/10"
                  : "border-border-strong bg-accent/5 hover:bg-surface-hover"
              }`}
            >
              <div className="text-xs font-medium text-foreground">{option.label}</div>
              <div className="text-xs text-subtle mt-0.5">{option.description}</div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

const meta = {
  title: "Settings/PrimaryGoalSelector",
  component: PrimaryGoalSelectorPreview,
} satisfies Meta<typeof PrimaryGoalSelectorPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unselected: Story = {
  args: { initialGoal: null },
};

export const SleepConsistency: Story = {
  args: { initialGoal: "sleepConsistency" },
};

export const RacePreparation: Story = {
  args: { initialGoal: "racePreparation" },
};
