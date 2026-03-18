import { describe, expect, it } from "vitest";
import { autoMealType, MEAL_OPTIONS, parseQuickAddForm } from "./meal.ts";

describe("autoMealType", () => {
  it("returns breakfast at hour 0", () => {
    expect(autoMealType(0)).toBe("breakfast");
  });

  it("returns breakfast at hour 9 (boundary)", () => {
    expect(autoMealType(9)).toBe("breakfast");
  });

  it("returns lunch at hour 10 (boundary)", () => {
    expect(autoMealType(10)).toBe("lunch");
  });

  it("returns lunch at hour 13 (boundary)", () => {
    expect(autoMealType(13)).toBe("lunch");
  });

  it("returns snack at hour 14 (boundary)", () => {
    expect(autoMealType(14)).toBe("snack");
  });

  it("returns snack at hour 16 (boundary)", () => {
    expect(autoMealType(16)).toBe("snack");
  });

  it("returns dinner at hour 17 (boundary)", () => {
    expect(autoMealType(17)).toBe("dinner");
  });

  it("returns dinner at hour 23", () => {
    expect(autoMealType(23)).toBe("dinner");
  });

  it("uses current hour when no argument", () => {
    const result = autoMealType();
    expect(["breakfast", "lunch", "snack", "dinner"]).toContain(result);
  });
});

describe("MEAL_OPTIONS", () => {
  it("has 5 options", () => {
    expect(MEAL_OPTIONS).toHaveLength(5);
  });

  it("has correct values in order", () => {
    const values = MEAL_OPTIONS.map((o) => o.value);
    expect(values).toEqual(["breakfast", "lunch", "dinner", "snack", "other"]);
  });

  it("has correct labels matching values", () => {
    for (const opt of MEAL_OPTIONS) {
      expect(opt.label).toBe(opt.value.charAt(0).toUpperCase() + opt.value.slice(1));
    }
  });
});

describe("parseQuickAddForm", () => {
  const validInput = {
    foodName: "Test Food",
    calories: "200",
    proteinGrams: "10",
    carbsGrams: "20",
    fatGrams: "5",
    meal: "lunch" as const,
    date: "2024-01-01",
  };

  it("parses valid input with all fields", () => {
    const result = parseQuickAddForm(validInput);
    expect(result).toEqual({
      date: "2024-01-01",
      meal: "lunch",
      foodName: "Test Food",
      calories: 200,
      proteinG: 10,
      carbsG: 20,
      fatG: 5,
    });
  });

  it("returns error for zero calories", () => {
    const result = parseQuickAddForm({ ...validInput, calories: "0" });
    expect(result).toEqual({ error: "Enter a calorie amount." });
  });

  it("returns error for negative calories", () => {
    const result = parseQuickAddForm({ ...validInput, calories: "-5" });
    expect(result).toEqual({ error: "Enter a calorie amount." });
  });

  it("returns error for non-numeric calories", () => {
    const result = parseQuickAddForm({ ...validInput, calories: "abc" });
    expect(result).toEqual({ error: "Enter a calorie amount." });
  });

  it("returns error for empty calories", () => {
    const result = parseQuickAddForm({ ...validInput, calories: "" });
    expect(result).toEqual({ error: "Enter a calorie amount." });
  });

  it("accepts calories of exactly 1", () => {
    const result = parseQuickAddForm({ ...validInput, calories: "1" });
    expect(result).not.toHaveProperty("error");
    if (!("error" in result)) {
      expect(result.calories).toBe(1);
    }
  });

  it("returns null macros for empty strings", () => {
    const result = parseQuickAddForm({
      ...validInput,
      proteinGrams: "",
      carbsGrams: "",
      fatGrams: "",
    });
    expect(result).not.toHaveProperty("error");
    if (!("error" in result)) {
      expect(result.proteinG).toBeNull();
      expect(result.carbsG).toBeNull();
      expect(result.fatG).toBeNull();
    }
  });

  it("parses individual macros when provided", () => {
    const result = parseQuickAddForm({
      ...validInput,
      proteinGrams: "25.5",
      carbsGrams: "",
      fatGrams: "8.3",
    });
    expect(result).not.toHaveProperty("error");
    if (!("error" in result)) {
      expect(result.proteinG).toBe(25.5);
      expect(result.carbsG).toBeNull();
      expect(result.fatG).toBe(8.3);
    }
  });

  it("defaults food name to Quick Add when empty", () => {
    const result = parseQuickAddForm({ ...validInput, foodName: "" });
    expect(result).not.toHaveProperty("error");
    if (!("error" in result)) {
      expect(result.foodName).toBe("Quick Add");
    }
  });

  it("defaults food name to Quick Add when only whitespace", () => {
    const result = parseQuickAddForm({ ...validInput, foodName: "   " });
    expect(result).not.toHaveProperty("error");
    if (!("error" in result)) {
      expect(result.foodName).toBe("Quick Add");
    }
  });

  it("trims food name whitespace", () => {
    const result = parseQuickAddForm({ ...validInput, foodName: "  Banana  " });
    expect(result).not.toHaveProperty("error");
    if (!("error" in result)) {
      expect(result.foodName).toBe("Banana");
    }
  });

  it("preserves date and meal from input", () => {
    const result = parseQuickAddForm({ ...validInput, date: "2025-06-15", meal: "dinner" });
    expect(result).not.toHaveProperty("error");
    if (!("error" in result)) {
      expect(result.date).toBe("2025-06-15");
      expect(result.meal).toBe("dinner");
    }
  });
});
