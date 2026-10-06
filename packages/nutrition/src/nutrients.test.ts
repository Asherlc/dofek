import { describe, expect, it } from "vitest";
import { NUTRIENTS, type NutrientCategory } from "./nutrients.ts";

describe("NUTRIENTS catalog", () => {
  it("has unique ids", () => {
    const ids = NUTRIENTS.map((nutrient) => nutrient.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique legacy field names", () => {
    const fields = NUTRIENTS.map((nutrient) => nutrient.legacyFieldName);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("has unique legacy column names", () => {
    const columns = NUTRIENTS.map((nutrient) => nutrient.legacyColumnName);
    expect(new Set(columns).size).toBe(columns.length);
  });

  it("every nutrient has a non-empty display name and unit", () => {
    for (const nutrient of NUTRIENTS) {
      expect(nutrient.displayName.length).toBeGreaterThan(0);
      expect(nutrient.unit.length).toBeGreaterThan(0);
    }
  });

  it("every nutrient has a valid category", () => {
    const validCategories: NutrientCategory[] = [
      "macro",
      "fat_breakdown",
      "other_macro",
      "vitamin",
      "mineral",
      "fatty_acid",
      "stimulant",
      "hydration",
    ];
    for (const nutrient of NUTRIENTS) {
      expect(validCategories).toContain(nutrient.category);
    }
  });

  it("every nutrient with an OFF key has a positive conversion factor", () => {
    for (const nutrient of NUTRIENTS) {
      if (nutrient.openFoodFactsKey !== null) {
        expect(nutrient.conversionFactor).toBeGreaterThan(0);
      }
    }
  });

  it("includes all expected vitamins", () => {
    const vitaminIds = NUTRIENTS.filter((nutrient) => nutrient.category === "vitamin").map(
      (nutrient) => nutrient.id,
    );
    expect(vitaminIds).toContain("vitamin_a");
    expect(vitaminIds).toContain("vitamin_c");
    expect(vitaminIds).toContain("vitamin_d");
    expect(vitaminIds).toContain("vitamin_b12");
  });

  it("includes macros, caffeine, and water in the canonical catalog", () => {
    expect(NUTRIENTS.find((nutrient) => nutrient.id === "calories")?.legacyFieldName).toBe(
      "calories",
    );
    expect(NUTRIENTS.find((nutrient) => nutrient.id === "protein")?.legacyFieldName).toBe(
      "proteinG",
    );
    expect(NUTRIENTS.find((nutrient) => nutrient.id === "carbohydrate")?.legacyFieldName).toBe(
      "carbsG",
    );
    expect(NUTRIENTS.find((nutrient) => nutrient.id === "fat")?.legacyFieldName).toBe("fatG");
    expect(NUTRIENTS.find((nutrient) => nutrient.id === "fiber")?.legacyFieldName).toBe("fiberG");
    expect(NUTRIENTS.find((nutrient) => nutrient.id === "caffeine")?.legacyFieldName).toBe(
      "caffeineMg",
    );
    expect(NUTRIENTS.find((nutrient) => nutrient.id === "water")?.legacyFieldName).toBe("waterMl");
  });

  it("includes all expected minerals", () => {
    const mineralIds = NUTRIENTS.filter((nutrient) => nutrient.category === "mineral").map(
      (nutrient) => nutrient.id,
    );
    expect(mineralIds).toContain("calcium");
    expect(mineralIds).toContain("iron");
    expect(mineralIds).toContain("magnesium");
    expect(mineralIds).toContain("zinc");
    expect(mineralIds).toContain("phosphorus");
  });

  it("sodium conversion factor is 1000 (OFF stores in grams)", () => {
    const sodium = NUTRIENTS.find((nutrient) => nutrient.id === "sodium");
    expect(sodium?.conversionFactor).toBe(1000);
  });

  it("omega-3 conversion factor is 1000 (OFF stores in grams)", () => {
    const omega3 = NUTRIENTS.find((nutrient) => nutrient.id === "omega_3");
    expect(omega3?.conversionFactor).toBe(1000);
  });
});
