import { describe, expect, it } from "vitest";
import {
  AutoSupplementsProvider,
  buildDailyEntries,
  type SupplementWithNutrition,
} from "./auto-supplements.ts";

// ============================================================
// Helpers
// ============================================================

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

/** Create a minimal supplement-with-nutrition row for testing.
 *  The view returns snake_case column names for nutrient fields. */
function makeRow(
  overrides: Partial<SupplementWithNutrition> & { name: string },
): SupplementWithNutrition {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    userId: TEST_USER_ID,
    user_id: TEST_USER_ID,
    sort_order: 0,
    amount: null,
    unit: null,
    form: null,
    description: null,
    meal: null,
    nutrition_data_id: null,
    calories: null,
    protein_g: null,
    carbs_g: null,
    fat_g: null,
    ...overrides,
  };
}

// ============================================================
// Sample supplement rows (as returned by v_supplement_with_nutrition view)
// ============================================================

const sampleRows: SupplementWithNutrition[] = [
  makeRow({ name: "Vitamin D3 5000 IU", description: "1 softgel", meal: "breakfast", calories: 0 }),
  makeRow({
    name: "Fish Oil",
    description: "2 softgels",
    meal: "breakfast",
    calories: 25,
    fat_g: 2.5,
    saturated_fat_g: 0.5,
    polyunsaturated_fat_g: 1.5,
    monounsaturated_fat_g: 0.5,
    cholesterol_mg: 10,
  }),
  makeRow({
    name: "Creatine Monohydrate",
    description: "5g powder",
    meal: "breakfast",
    calories: 0,
  }),
  makeRow({
    name: "Magnesium Glycinate 400mg",
    description: "2 capsules",
    meal: "dinner",
    calories: 0,
    calcium_mg: 5,
    iron_mg: 0.1,
  }),
];

// ============================================================
// Tests
// ============================================================

describe("Auto-Supplements Provider", () => {
  describe("buildDailyEntries", () => {
    it("generates entries for a single date", () => {
      const entries = buildDailyEntries(sampleRows, ["2024-03-15"]);
      expect(entries).toHaveLength(4);
      for (const e of entries) {
        expect(e.date).toBe("2024-03-15");
        expect(e.category).toBe("supplement");
        expect(e.providerId).toBe("auto-supplements");
      }
    });

    it("generates entries for multiple dates", () => {
      const entries = buildDailyEntries(sampleRows, ["2024-03-15", "2024-03-16"]);
      expect(entries).toHaveLength(8); // 4 supplements x 2 days
    });

    it("generates stable externalIds from name + userId + date", () => {
      const entries = buildDailyEntries(sampleRows, ["2024-03-15"]);
      const vitD = entries.find((e) => e.foodName === "Vitamin D3 5000 IU");
      expect(vitD?.externalId).toBe(`auto:vitamin-d3-5000-iu:${TEST_USER_ID}:2024-03-15`);
    });

    it("maps all nutritional fields from supplement row", () => {
      const entries = buildDailyEntries(sampleRows, ["2024-03-15"]);
      const fishOil = entries.find((e) => e.foodName === "Fish Oil");
      expect(fishOil).toBeDefined();
      if (!fishOil) return;
      expect(fishOil.nutrients.calories).toBe(25);
      expect(fishOil.nutrients.fatG).toBeCloseTo(2.5);
      expect(fishOil.nutrients.saturatedFatG).toBeCloseTo(0.5);
      expect(fishOil.nutrients.polyunsaturatedFatG).toBeCloseTo(1.5);
      expect(fishOil.nutrients.monounsaturatedFatG).toBeCloseTo(0.5);
      expect(fishOil.nutrients.cholesterolMg).toBeCloseTo(10);
    });

    it("assigns correct meal from supplement row", () => {
      const entries = buildDailyEntries(sampleRows, ["2024-03-15"]);
      const vitD = entries.find((e) => e.foodName === "Vitamin D3 5000 IU");
      const mag = entries.find((e) => e.foodName === "Magnesium Glycinate 400mg");
      expect(vitD?.meal).toBe("breakfast");
      expect(mag?.meal).toBe("dinner");
    });

    it("defaults meal to other when not specified", () => {
      const entries = buildDailyEntries([makeRow({ name: "Zinc 50mg" })], ["2024-03-15"]);
      expect(entries[0]?.meal).toBe("other");
    });

    it("slugifies names consistently for externalId", () => {
      const entries = buildDailyEntries(
        [makeRow({ name: "CoQ10 200mg (Ubiquinol)" })],
        ["2024-03-15"],
      );
      expect(entries[0]?.externalId).toBe(`auto:coq10-200mg-ubiquinol:${TEST_USER_ID}:2024-03-15`);
    });

    it("includes userId from the supplement row", () => {
      const customUserId = "11111111-1111-1111-1111-111111111111";
      const entries = buildDailyEntries(
        [makeRow({ name: "Test", user_id: customUserId, userId: customUserId })],
        ["2024-03-15"],
      );
      expect(entries[0]?.userId).toBe(customUserId);
    });

    it("returns empty array for empty dates", () => {
      const entries = buildDailyEntries([makeRow({ name: "Test" })], []);
      expect(entries).toHaveLength(0);
    });

    it("returns empty array for empty supplements", () => {
      const entries = buildDailyEntries([], ["2024-03-15"]);
      expect(entries).toHaveLength(0);
    });

    it("sets numberOfUnits to 1 for all entries", () => {
      const entries = buildDailyEntries([makeRow({ name: "Test" })], ["2024-03-15"]);
      expect(entries[0]?.numberOfUnits).toBe(1);
    });

    it("sets foodDescription from supplement description", () => {
      const entries = buildDailyEntries(
        [makeRow({ name: "Test", description: "2 capsules" })],
        ["2024-03-15"],
      );
      expect(entries[0]?.foodDescription).toBe("2 capsules");
    });

    it("sets foodDescription to null when no description", () => {
      const entries = buildDailyEntries([makeRow({ name: "Test" })], ["2024-03-15"]);
      expect(entries[0]?.foodDescription).toBeNull();
    });

    it("includes all nutrient keys (camelCase), with null for undefined nutrients", () => {
      const entries = buildDailyEntries(
        [makeRow({ name: "Test", calories: 10, protein_g: 5 })],
        ["2024-03-15"],
      );
      expect(entries[0]?.nutrients.calories).toBe(10);
      expect(entries[0]?.nutrients.proteinG).toBe(5);
      expect(entries[0]?.nutrients.fatG).toBeNull();
      expect(entries[0]?.nutrients.omega3Mg).toBeNull();
    });
  });

  describe("AutoSupplementsProvider", () => {
    it("provider id and name are correct", () => {
      const provider = new AutoSupplementsProvider();
      expect(provider.id).toBe("auto-supplements");
      expect(provider.name).toBe("Auto-Supplements");
    });

    it("validate always returns null (supplements stored in DB)", () => {
      const provider = new AutoSupplementsProvider();
      expect(provider.validate()).toBeNull();
    });
  });
});
