// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FoodEntryRow } from "./FoodEntryRow";

describe("FoodEntryRow", () => {
  it("includes the visible row summary and expanded nutrients in its accessible semantics", () => {
    render(
      <FoodEntryRow
        foodName="Chicken Bowl"
        servingDescription="1 bowl"
        calories={420}
        nutrients={[
          {
            id: "protein",
            label: "Protein",
            amount: 32,
            unit: "g",
            category: "macro",
            sortOrder: 2,
            valueText: "32 g",
          },
          {
            id: "sodium",
            label: "Sodium",
            amount: 680,
            unit: "mg",
            category: "other_macro",
            sortOrder: 201,
            valueText: "680 mg",
          },
        ]}
        onDelete={vi.fn()}
      />,
    );

    const collapsedButton = screen.getByRole("button", {
      name: "Show nutrition for Chicken Bowl, 1 bowl, 420 kcal",
    });
    expect(collapsedButton).not.toHaveAttribute("aria-describedby");

    fireEvent.click(collapsedButton);

    const expandedButton = screen.getByRole("button", {
      name: "Hide nutrition for Chicken Bowl, 1 bowl, 420 kcal",
    });
    const describedBy = expandedButton.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const descriptionText = describedBy
      ?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(descriptionText).toContain("Protein");
    expect(descriptionText).toContain("32 g");
    expect(descriptionText).toContain("Sodium");
    expect(descriptionText).toContain("680 mg");
  });

  it("expands to show detailed nutrients when clicked", () => {
    render(
      <FoodEntryRow
        foodName="Chicken Bowl"
        servingDescription="1 bowl"
        calories={420}
        nutrients={[
          {
            id: "protein",
            label: "Protein",
            amount: 32,
            unit: "g",
            category: "macro",
            sortOrder: 2,
            valueText: "32 g",
          },
          {
            id: "sodium",
            label: "Sodium",
            amount: 680,
            unit: "mg",
            category: "other_macro",
            sortOrder: 201,
            valueText: "680 mg",
          },
        ]}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.queryByText("Sodium")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Show nutrition for Chicken Bowl/ }));

    expect(screen.getByText("Protein")).toBeTruthy();
    expect(screen.getByText("32 g")).toBeTruthy();
    expect(screen.getByText("Sodium")).toBeTruthy();
    expect(screen.getByText("680 mg")).toBeTruthy();
  });

  it("does not delete when expanding the row", () => {
    const onDelete = vi.fn();

    render(
      <FoodEntryRow
        foodName="Chicken Bowl"
        servingDescription={null}
        calories={420}
        nutrients={[]}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Show nutrition for Chicken Bowl/ }));

    expect(onDelete).not.toHaveBeenCalled();
  });
});
