import { describe, expect, it } from "vitest";
import { autoMealType, formatDateYmd, parseQuickAddForm, type QuickAddFormInput } from "./meal";

describe("autoMealType", () => {
  it("returns breakfast before 10am", () => {
    expect(autoMealType(0)).toBe("breakfast");
    expect(autoMealType(6)).toBe("breakfast");
    expect(autoMealType(9)).toBe("breakfast");
  });

  it("returns lunch from 10am to 1pm", () => {
    expect(autoMealType(10)).toBe("lunch");
    expect(autoMealType(13)).toBe("lunch");
  });

  it("returns snack from 2pm to 4pm", () => {
    expect(autoMealType(14)).toBe("snack");
    expect(autoMealType(16)).toBe("snack");
  });

  it("returns dinner from 5pm onward", () => {
    expect(autoMealType(17)).toBe("dinner");
    expect(autoMealType(21)).toBe("dinner");
    expect(autoMealType(23)).toBe("dinner");
  });
});

describe("formatDateYmd", () => {
  it("formats a date as YYYY-MM-DD", () => {
    expect(formatDateYmd(new Date(2026, 2, 17))).toBe("2026-03-17");
  });

  it("zero-pads single-digit months and days", () => {
    expect(formatDateYmd(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

function validInput(overrides?: Partial<QuickAddFormInput>): QuickAddFormInput {
  return {
    foodName: "Banana",
    calories: "250",
    proteinGrams: "",
    carbsGrams: "",
    fatGrams: "",
    meal: "lunch",
    date: "2026-03-17",
    ...overrides,
  };
}

describe("parseQuickAddForm", () => {
  it("returns a valid payload for minimal input", () => {
    const result = parseQuickAddForm(validInput());
    expect(result).toEqual({
      date: "2026-03-17",
      meal: "lunch",
      foodName: "Banana",
      calories: 250,
      proteinG: null,
      carbsG: null,
      fatG: null,
    });
  });

  it("parses optional macro fields when provided", () => {
    const result = parseQuickAddForm(
      validInput({ proteinGrams: "30", carbsGrams: "45.5", fatGrams: "12" }),
    );
    expect(result).not.toHaveProperty("error");
    if (!("error" in result)) {
      expect(result.proteinG).toBe(30);
      expect(result.carbsG).toBe(45.5);
      expect(result.fatG).toBe(12);
    }
  });

  it("returns error for empty calories", () => {
    const result = parseQuickAddForm(validInput({ calories: "" }));
    expect(result).toEqual({ error: "Enter a calorie amount." });
  });

  it("returns error for non-numeric calories", () => {
    const result = parseQuickAddForm(validInput({ calories: "abc" }));
    expect(result).toEqual({ error: "Enter a calorie amount." });
  });

  it("returns error for zero calories", () => {
    const result = parseQuickAddForm(validInput({ calories: "0" }));
    expect(result).toEqual({ error: "Enter a calorie amount." });
  });

  it("returns error for negative calories", () => {
    const result = parseQuickAddForm(validInput({ calories: "-100" }));
    expect(result).toEqual({ error: "Enter a calorie amount." });
  });

  it("trims whitespace from food name", () => {
    const result = parseQuickAddForm(validInput({ foodName: "  Rice  " }));
    expect(result).not.toHaveProperty("error");
    if (!("error" in result)) {
      expect(result.foodName).toBe("Rice");
    }
  });

  it("defaults food name to Quick Add when blank", () => {
    const result = parseQuickAddForm(validInput({ foodName: "   " }));
    expect(result).not.toHaveProperty("error");
    if (!("error" in result)) {
      expect(result.foodName).toBe("Quick Add");
    }
  });

  it("sets macros to null when fields are empty strings", () => {
    const result = parseQuickAddForm(
      validInput({ proteinGrams: "", carbsGrams: "", fatGrams: "" }),
    );
    expect(result).not.toHaveProperty("error");
    if (!("error" in result)) {
      expect(result.proteinG).toBeNull();
      expect(result.carbsG).toBeNull();
      expect(result.fatG).toBeNull();
    }
  });
});
