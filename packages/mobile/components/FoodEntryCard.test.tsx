// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FoodEntryCard } from "./FoodEntryCard";

// biome-ignore lint/suspicious/noConsole: React Native web emits onLongPress warnings in jsdom.
const originalConsoleError = console.error.bind(console);
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

describe("FoodEntryCard", () => {
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((message, ...rest) => {
      const isLongPressWarning =
        typeof message === "string" &&
        message.includes("Unknown event handler property") &&
        rest.some((item) => item === "onLongPress");
      if (isLongPressWarning) return;

      originalConsoleError(message, ...rest);
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
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
