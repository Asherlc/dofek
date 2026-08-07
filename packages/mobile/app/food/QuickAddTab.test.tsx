import { chartColors } from "@dofek/scoring/colors";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickAddTab } from "./QuickAddTab";

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

describe("QuickAddTab", () => {
  it("uses neutral categorical colors for optional macro fields", () => {
    const noop = vi.fn();
    render(
      <QuickAddTab
        foodName=""
        onFoodNameChange={noop}
        selectedMeal="breakfast"
        onMealChange={noop}
        calories=""
        onCaloriesChange={noop}
        proteinGrams=""
        onProteinChange={noop}
        carbsGrams=""
        onCarbsChange={noop}
        fatGrams=""
        onFatChange={noop}
        isWide={false}
        isSaving={false}
        onSave={noop}
      />,
    );

    expect(macroDot("Protein").style.backgroundColor).toBe(cssRgb(chartColors.blue));
    expect(macroDot("Carbs").style.backgroundColor).toBe(cssRgb(chartColors.purple));
    expect(macroDot("Fat").style.backgroundColor).toBe(cssRgb(chartColors.teal));
  });
});
