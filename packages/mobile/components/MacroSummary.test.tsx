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
        macros={{
          protein: { grams: 110, calories: 440, energySharePercentage: 31 },
          carbs: { grams: 140, calories: 560, energySharePercentage: 40 },
          fat: { grams: 45, calories: 405, energySharePercentage: 29 },
        }}
      />,
    );

    expect(macroDot("Protein").style.backgroundColor).toBe(cssRgb(chartColors.blue));
    expect(macroDot("Carbs").style.backgroundColor).toBe(cssRgb(chartColors.purple));
    expect(macroDot("Fat").style.backgroundColor).toBe(cssRgb(chartColors.teal));
  });

  it("labels energy shares separately from logged grams with exact accessible context", () => {
    render(
      <MacroSummary
        macros={{
          protein: { grams: 65, calories: 260, energySharePercentage: 25 },
          carbs: { grams: 107.5, calories: 430, energySharePercentage: 42 },
          fat: { grams: 340 / 9, calories: 340, energySharePercentage: 33 },
        }}
      />,
    );

    expect(screen.getByText("Share of energy")).not.toBeNull();
    expect(screen.getByText("25%")).not.toBeNull();
    expect(screen.getByText("65 g logged")).not.toBeNull();
    expect(screen.getByLabelText("Protein: 25% share of energy; 65 grams logged")).not.toBeNull();
  });
});
