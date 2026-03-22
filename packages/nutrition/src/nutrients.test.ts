import { describe, expect, it } from "vitest";
import {
  getNutrientById,
  getNutrientByLegacyField,
  getNutrientsByCategory,
  NUTRIENTS,
  type NutrientCategory,
} from "./nutrients.ts";

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
      "fat_breakdown",
      "other_macro",
      "vitamin",
      "mineral",
      "fatty_acid",
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
    const sodium = getNutrientById("sodium");
    expect(sodium?.conversionFactor).toBe(1000);
  });

  it("omega-3 conversion factor is 1000 (OFF stores in grams)", () => {
    const omega3 = getNutrientById("omega_3");
    expect(omega3?.conversionFactor).toBe(1000);
  });
});

describe("getNutrientById", () => {
  it("returns the nutrient for a valid id", () => {
    const result = getNutrientById("vitamin_a");
    expect(result).not.toBeNull();
    expect(result?.displayName).toBe("Vitamin A");
    expect(result?.unit).toBe("mcg");
  });

  it("returns null for an unknown id", () => {
    expect(getNutrientById("nonexistent")).toBeNull();
  });
});

describe("getNutrientByLegacyField", () => {
  it("maps camelCase field name to nutrient", () => {
    const result = getNutrientByLegacyField("vitaminAMcg");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("vitamin_a");
  });

  it("returns null for unknown field", () => {
    expect(getNutrientByLegacyField("unknownField")).toBeNull();
  });
});

describe("getNutrientsByCategory", () => {
  it("returns only nutrients in the given category", () => {
    const vitamins = getNutrientsByCategory("vitamin");
    expect(vitamins.length).toBeGreaterThan(0);
    for (const vitamin of vitamins) {
      expect(vitamin.category).toBe("vitamin");
    }
  });

  it("returns nutrients sorted by sortOrder", () => {
    const minerals = getNutrientsByCategory("mineral");
    for (let index = 1; index < minerals.length; index++) {
      const previous = minerals[index - 1];
      const current = minerals[index];
      if (previous && current) {
        expect(previous.sortOrder).toBeLessThanOrEqual(current.sortOrder);
      }
    }
  });
});
