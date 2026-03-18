import { describe, expect, it } from "vitest";
import { autoMealType, MEAL_OPTIONS, parseQuickAddForm } from "./meal.ts";

describe("autoMealType", () => {
  it("returns breakfast before 10am", () => {
    expect(autoMealType(8)).toBe("breakfast");
  });

  it("returns lunch between 10am and 2pm", () => {
    expect(autoMealType(12)).toBe("lunch");
  });

  it("returns snack between 2pm and 5pm", () => {
    expect(autoMealType(15)).toBe("snack");
  });

  it("returns dinner after 5pm", () => {
    expect(autoMealType(19)).toBe("dinner");
  });
});

describe("MEAL_OPTIONS", () => {
  it("has 5 options", () => {
    expect(MEAL_OPTIONS).toHaveLength(5);
  });

  it("has correct values", () => {
    const values = MEAL_OPTIONS.map((o) => o.value);
    expect(values).toEqual(["breakfast", "lunch", "dinner", "snack", "other"]);
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

  it("parses valid input", () => {
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

  it("returns error for non-numeric calories", () => {
    const result = parseQuickAddForm({ ...validInput, calories: "abc" });
    expect(result).toEqual({ error: "Enter a calorie amount." });
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

  it("defaults food name to Quick Add when empty", () => {
    const result = parseQuickAddForm({ ...validInput, foodName: "  " });
    expect(result).not.toHaveProperty("error");
    if (!("error" in result)) {
      expect(result.foodName).toBe("Quick Add");
    }
  });
});
