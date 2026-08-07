// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../../app/food/add-types";
import { FoodResultCard } from "../../app/food/FoodResultCard";

const result: SearchResult = {
  source: "history",
  name: "Greek Yogurt",
  brand: null,
  calories: 120,
  proteinG: 15,
  carbsG: 8,
  fatG: 2,
  servingDescription: "1 cup",
  barcode: null,
};

describe("FoodResultCard", () => {
  it("includes serving and source context in its accessible action name", () => {
    render(<FoodResultCard result={result} onSelect={vi.fn()} sourceLabel="Food history" />);

    expect(
      screen.getByRole("button", {
        name: "Select Greek Yogurt, 1 cup, Food history",
      }),
    ).toBeTruthy();
  });
});
