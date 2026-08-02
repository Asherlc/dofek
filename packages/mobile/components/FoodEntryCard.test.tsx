// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FoodEntryCard } from "./FoodEntryCard";

describe("FoodEntryCard", () => {
  it("includes the visible serving and nutrient summary in its accessible label", () => {
    render(
      <FoodEntryCard
        entry={{
          id: "1",
          food_name: "Chicken Bowl",
          food_description: "1 bowl",
          meal: "lunch",
          calories: 420,
          protein_g: 32,
          carbs_g: 41.5,
          fat_g: 12,
          sodium_mg: 680,
        }}
        onDelete={vi.fn()}
        deleting={false}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Show details for Chicken Bowl. 1 bowl. Protein: 32 g. Carbs: 42 g. Fat: 12 g. Calories: 420 kcal",
    });
    expect(button).toBeTruthy();

    fireEvent.click(button);

    expect(
      screen.getByLabelText(
        "Macros: Calories: 420 kcal, Protein: 32 g, Carbohydrates: 42 g, Fat: 12 g. Other nutrients: Sodium: 680 mg",
      ),
    ).toBeTruthy();
  });

  it("expands to show detailed nutrients when tapped", () => {
    render(
      <FoodEntryCard
        entry={{
          id: "1",
          food_name: "Chicken Bowl",
          food_description: "1 bowl",
          meal: "lunch",
          calories: 420,
          protein_g: 32,
          carbs_g: 41.5,
          fat_g: 12,
          sodium_mg: 680,
        }}
        onDelete={vi.fn()}
        deleting={false}
      />,
    );

    expect(screen.queryByText("Sodium")).toBeNull();

    fireEvent.click(screen.getByText("Chicken Bowl"));

    expect(screen.getByText("Protein")).toBeTruthy();
    expect(screen.getByText("32 g")).toBeTruthy();
    expect(screen.getByText("Sodium")).toBeTruthy();
    expect(screen.getByText("680 mg")).toBeTruthy();
  });
});
