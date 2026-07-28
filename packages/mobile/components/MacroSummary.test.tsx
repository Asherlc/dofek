import { chartColors } from "@dofek/scoring/colors";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MacroSummary } from "./MacroSummary";

function cssRgb(hexColor: string): string {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hexColor.slice(start, start + 2), 16));
  return `rgb(${channels.join(", ")})`;
}

function macroDot(label: string): HTMLElement {
  const dot = screen.getByText(label).parentElement?.firstElementChild;
  if (!(dot instanceof HTMLElement)) {
    throw new Error(`Expected a category dot for ${label}`);
  }
  return dot;
}

describe("MacroSummary", () => {
  it("uses neutral categorical colors for macro identity", () => {
    render(
      <MacroSummary
        calories={1_250}
        calorieGoal={{ target: 2_000, remaining: 750, over: 0, progressPercentage: 62.5 }}
        macros={{
          protein: { grams: 110, calories: 440, percentage: 35 },
          carbs: { grams: 140, calories: 560, percentage: 45 },
          fat: { grams: 45, calories: 405, percentage: 32 },
        }}
      />,
    );

    expect(macroDot("Protein").style.backgroundColor).toBe(cssRgb(chartColors.blue));
    expect(macroDot("Carbs").style.backgroundColor).toBe(cssRgb(chartColors.purple));
    expect(macroDot("Fat").style.backgroundColor).toBe(cssRgb(chartColors.teal));
  });
});
