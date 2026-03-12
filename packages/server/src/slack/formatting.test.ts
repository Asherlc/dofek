import { describe, expect, it } from "vitest";
import type { NutritionItemWithMeal } from "../lib/ai-nutrition.ts";
import { formatConfirmationMessage, formatSavedMessage } from "./formatting.ts";

const sampleItem: NutritionItemWithMeal = {
  foodName: "Chicken Burrito",
  foodDescription: "1 large burrito with rice, beans, chicken, cheese",
  category: "fast_food",
  calories: 650,
  proteinG: 35.2,
  carbsG: 72.1,
  fatG: 22.5,
  fiberG: 8.0,
  saturatedFatG: 8.5,
  sugarG: 3.2,
  sodiumMg: 1200,
  meal: "lunch",
};

const secondItem: NutritionItemWithMeal = {
  foodName: "Coca-Cola",
  foodDescription: "1 can (355ml)",
  category: "beverages",
  calories: 140,
  proteinG: 0,
  carbsG: 39,
  fatG: 0,
  fiberG: 0,
  saturatedFatG: 0,
  sugarG: 39,
  sodiumMg: 45,
  meal: "lunch",
};

describe("formatConfirmationMessage", () => {
  it("formats a single food item with nutrition details and buttons", () => {
    const result = formatConfirmationMessage([sampleItem]);

    expect(result.blocks).toBeDefined();
    expect(result.blocks.length).toBeGreaterThan(0);

    const text = JSON.stringify(result.blocks);
    expect(text).toContain("Chicken Burrito");
    expect(text).toContain("650");
    expect(text).toContain("35.2");
    expect(text).toContain("lunch");

    expect(text).toContain("confirm_food");
    expect(text).toContain("cancel_food");
  });

  it("formats multiple food items", () => {
    const result = formatConfirmationMessage([sampleItem, secondItem]);

    const text = JSON.stringify(result.blocks);
    expect(text).toContain("Chicken Burrito");
    expect(text).toContain("Coca-Cola");
    expect(text).toContain("140");

    // Should show totals
    expect(text).toContain("790"); // 650 + 140 total calories
  });

  it("stores item data in button action value for confirmation", () => {
    const result = formatConfirmationMessage([sampleItem]);

    const actionsBlock = result.blocks.find((b: Record<string, unknown>) => b.type === "actions") as
      | Record<string, unknown>
      | undefined;
    expect(actionsBlock).toBeDefined();

    const elements = actionsBlock!.elements as Array<Record<string, unknown>>;
    const confirmButton = elements.find((e) => e.action_id === "confirm_food");
    expect(confirmButton).toBeDefined();

    // Value should be parseable JSON containing the items
    const parsed = JSON.parse(confirmButton!.value as string);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].foodName).toBe("Chicken Burrito");
  });
});

describe("formatSavedMessage", () => {
  it("shows a success message with item count", () => {
    const result = formatSavedMessage([sampleItem]);

    const text = JSON.stringify(result.blocks);
    expect(text).toContain("Chicken Burrito");
    expect(text).toContain("650");
  });

  it("shows multiple saved items", () => {
    const result = formatSavedMessage([sampleItem, secondItem]);

    const text = JSON.stringify(result.blocks);
    expect(text).toContain("Chicken Burrito");
    expect(text).toContain("Coca-Cola");
  });
});
