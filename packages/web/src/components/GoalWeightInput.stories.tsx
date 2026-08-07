import { formatMeasurementText, UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

/**
 * Storybook-only presentational stand-in for GoalWeightInput.
 * The real component depends on tRPC hooks which aren't available in Storybook.
 * This renders the same markup to verify visual states.
 */
function GoalWeightInputStory({
  goalWeightKg,
  unitSystem = "metric",
}: {
  goalWeightKg: number | null;
  unitSystem?: "metric" | "imperial";
}) {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const units = new UnitConverter(unitSystem);

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <input
          type="number"
          step="0.1"
          className="w-20 rounded bg-surface border border-border px-2 py-1 text-sm"
          placeholder={units.weightLabel}
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
        />
        <button type="button" className="text-xs text-primary hover:text-primary/80">
          Save
        </button>
        <button
          type="button"
          className="text-xs text-muted hover:text-subtle"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {goalWeightKg != null ? (
        <>
          <span className="text-xs text-muted">
            Goal: {formatMeasurementText(units.formatWeight(goalWeightKg))}
          </span>
          <button
            type="button"
            className="text-xs text-primary hover:text-primary/80"
            onClick={() => {
              setInputValue(String(goalWeightKg));
              setEditing(true);
            }}
          >
            Edit
          </button>
          <button type="button" className="text-xs text-muted hover:text-subtle">
            Clear
          </button>
        </>
      ) : (
        <button
          type="button"
          className="text-xs text-primary hover:text-primary/80"
          onClick={() => {
            setInputValue("");
            setEditing(true);
          }}
        >
          Set Goal Weight
        </button>
      )}
    </div>
  );
}

const meta = {
  title: "Body/GoalWeightInput",
  component: GoalWeightInputStory,
  tags: ["autodocs"],
  args: {
    goalWeightKg: null,
  },
} satisfies Meta<typeof GoalWeightInputStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const NoGoalSet: Story = {};

export const WithGoal: Story = {
  args: {
    goalWeightKg: 75,
  },
};

export const ImperialWithGoal: Story = {
  args: {
    goalWeightKg: 75,
    unitSystem: "imperial",
  },
};
