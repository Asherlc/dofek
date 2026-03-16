import { describe, expect, it } from "vitest";
import type { NutritionItemWithMeal } from "../lib/ai-nutrition.ts";
import { formatConfirmationMessage, formatMicroLine, formatSavedMessage } from "./formatting.ts";

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
  ironMg: 3.2,
  calciumMg: 210,
  vitaminCMg: 8.5,
  magnesiumMg: 45,
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

  it("stores button value in confirm action for entry ID lookup", () => {
    const entryIds = "abc-123,def-456";
    const result = formatConfirmationMessage([sampleItem], entryIds);

    const actionsBlock: Record<string, unknown> | undefined = result.blocks.find(
      (b: Record<string, unknown>) => b.type === "actions",
    );
    expect(actionsBlock).toBeDefined();

    const elements: Array<Record<string, unknown>> = actionsBlock?.elements;
    const confirmButton = elements.find((e) => e.action_id === "confirm_food");
    expect(confirmButton).toBeDefined();

    // Value should be the entry IDs string
    expect(confirmButton?.value).toBe(entryIds);
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

describe("formatMicroLine", () => {
  it("formats non-zero micronutrients", () => {
    const line = formatMicroLine(sampleItem);
    expect(line).toContain("Iron: 3.2mg");
    expect(line).toContain("Ca: 210mg");
    expect(line).toContain("Vit C: 8.5mg");
    expect(line).toContain("Mg: 45mg");
  });

  it("omits micronutrients that are undefined", () => {
    const line = formatMicroLine(sampleItem);
    expect(line).not.toContain("Vit D");
    expect(line).not.toContain("B12");
    expect(line).not.toContain("Ω3");
  });

  it("returns empty string when no micronutrients present", () => {
    const line = formatMicroLine(secondItem);
    expect(line).toBe("");
  });

  it("rounds large values to integers and small values to one decimal", () => {
    const item: NutritionItemWithMeal = {
      ...secondItem,
      calciumMg: 250.7,
      ironMg: 3.7,
    };
    const line = formatMicroLine(item);
    expect(line).toContain("Ca: 251mg");
    expect(line).toContain("Iron: 3.7mg");
  });
});

describe("formatConfirmationMessage button value size", () => {
  it("keeps button value under Slack's 2000-character limit with entry IDs", () => {
    const richItem: NutritionItemWithMeal = {
      foodName: "Scrambled eggs (2 large)",
      foodDescription: "Two large eggs scrambled with butter",
      category: "eggs",
      meal: "breakfast",
      calories: 196,
      proteinG: 13.5,
      carbsG: 1.6,
      fatG: 15.0,
      fiberG: 0,
      saturatedFatG: 5.3,
      sugarG: 1.1,
      sodiumMg: 342,
      polyunsaturatedFatG: 2.8,
      monounsaturatedFatG: 5.7,
      transFatG: 0.1,
      cholesterolMg: 372,
      potassiumMg: 153,
      calciumMg: 56,
      ironMg: 1.7,
      magnesiumMg: 12,
      zincMg: 1.3,
      seleniumMcg: 22.5,
      copperMg: 0.1,
      manganeseMg: 0.03,
      chromiumMcg: 0.5,
      iodineMcg: 24,
      vitaminAMcg: 160,
      vitaminCMg: 0,
      vitaminDMcg: 2,
      vitaminEMg: 1.0,
      vitaminKMcg: 0.6,
      vitaminB1Mg: 0.1,
      vitaminB2Mg: 0.4,
      vitaminB3Mg: 0.1,
      vitaminB5Mg: 0.8,
      vitaminB6Mg: 0.2,
      vitaminB7Mcg: 10,
      vitaminB9Mcg: 47,
      vitaminB12Mcg: 0.9,
      omega3Mg: 180,
      omega6Mg: 1500,
    };
    const items = [
      richItem,
      { ...richItem, foodName: "Toast with butter" },
      { ...richItem, foodName: "Coffee with milk" },
    ];
    // Simulate 3 UUIDs joined by commas (each UUID is 36 chars)
    const entryIds =
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee,ffffffff-1111-2222-3333-444444444444,55555555-6666-7777-8888-999999999999";
    const result = formatConfirmationMessage(items, entryIds);
    const actionsBlock: Record<string, unknown> | undefined = result.blocks.find(
      (b: Record<string, unknown>) => b.type === "actions",
    );
    const elements: Array<Record<string, unknown>> = actionsBlock?.elements;
    const confirmButton = elements.find((e) => e.action_id === "confirm_food");
    const value = String(confirmButton?.value);
    expect(value.length).toBeLessThanOrEqual(2000);
    // Value should be comma-separated UUIDs
    expect(value).toBe(entryIds);
  });
});

describe("formatConfirmationMessage with micronutrients", () => {
  it("includes micronutrient line in item section", () => {
    const result = formatConfirmationMessage([sampleItem]);
    const text = JSON.stringify(result.blocks);
    expect(text).toContain("Iron:");
    expect(text).toContain("Ca:");
  });

  it("omits micronutrient line when item has no micros", () => {
    const result = formatConfirmationMessage([secondItem]);
    const text = JSON.stringify(result.blocks);
    expect(text).not.toContain("Iron:");
    expect(text).not.toContain("Vit D:");
  });

  it("shows summed micronutrient totals for multiple items", () => {
    const itemWithMicros: NutritionItemWithMeal = {
      ...secondItem,
      ironMg: 1.0,
      calciumMg: 10,
    };
    const result = formatConfirmationMessage([sampleItem, itemWithMicros]);
    const text = JSON.stringify(result.blocks);
    // Total iron: 3.2 + 1.0 = 4.2, total calcium: 210 + 10 = 220
    expect(text).toContain("Iron: 4.2mg");
    expect(text).toContain("Ca: 220mg");
  });
});
