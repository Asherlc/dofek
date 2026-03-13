import { describe, expect, it } from "vitest";
import type { NutritionItemWithMeal } from "../lib/ai-nutrition.ts";
import { removePendingItems, retrievePendingItems, storePendingItems } from "./pending-items.ts";

const sampleItem: NutritionItemWithMeal = {
  foodName: "Chicken Burrito",
  foodDescription: "1 large burrito",
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

describe("pending items store", () => {
  it("stores and retrieves items by key", () => {
    const key = storePendingItems([sampleItem]);
    const retrieved = retrievePendingItems(key);
    expect(retrieved).toEqual([sampleItem]);
  });

  it("returns null for unknown keys", () => {
    expect(retrievePendingItems("nonexistent-key")).toBeNull();
  });

  it("removes items after consumption", () => {
    const key = storePendingItems([sampleItem]);
    removePendingItems(key);
    expect(retrievePendingItems(key)).toBeNull();
  });

  it("generates unique keys for each store call", () => {
    const key1 = storePendingItems([sampleItem]);
    const key2 = storePendingItems([sampleItem]);
    expect(key1).not.toBe(key2);
  });

  it("returns a UUID-format key", () => {
    const key = storePendingItems([sampleItem]);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
