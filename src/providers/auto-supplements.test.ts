import { describe, expect, it } from "vitest";
import type { supplement } from "../db/schema.ts";
import { AutoSupplementsProvider, buildDailyEntries } from "./auto-supplements.ts";

// ============================================================
// Helpers
// ============================================================

type SupplementRow = typeof supplement.$inferSelect;

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

/** Create a minimal supplement row for testing. */
function makeRow(overrides: Partial<SupplementRow> & { name: string }): SupplementRow {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    userId: TEST_USER_ID,
    sortOrder: 0,
    amount: null,
    unit: null,
    form: null,
    description: null,
    meal: null,
    calories: null,
    proteinG: null,
    carbsG: null,
    fatG: null,
    saturatedFatG: null,
    polyunsaturatedFatG: null,
    monounsaturatedFatG: null,
    transFatG: null,
    cholesterolMg: null,
    sodiumMg: null,
    potassiumMg: null,
    fiberG: null,
    sugarG: null,
    vitaminAMcg: null,
    vitaminCMg: null,
    vitaminDMcg: null,
    vitaminEMg: null,
    vitaminKMcg: null,
    vitaminB1Mg: null,
    vitaminB2Mg: null,
    vitaminB3Mg: null,
    vitaminB5Mg: null,
    vitaminB6Mg: null,
    vitaminB7Mcg: null,
    vitaminB9Mcg: null,
    vitaminB12Mcg: null,
    calciumMg: null,
    ironMg: null,
    magnesiumMg: null,
    zincMg: null,
    seleniumMcg: null,
    copperMg: null,
    manganeseMg: null,
    chromiumMcg: null,
    iodineMcg: null,
    omega3Mg: null,
    omega6Mg: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ============================================================
// Sample supplement rows
// ============================================================

const sampleRows: SupplementRow[] = [
  makeRow({ name: "Vitamin D3 5000 IU", description: "1 softgel", meal: "breakfast", calories: 0 }),
  makeRow({
    name: "Fish Oil",
    description: "2 softgels",
    meal: "breakfast",
    calories: 25,
    fatG: 2.5,
    saturatedFatG: 0.5,
    polyunsaturatedFatG: 1.5,
    monounsaturatedFatG: 0.5,
    cholesterolMg: 10,
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
    calciumMg: 5,
    ironMg: 0.1,
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
        [makeRow({ name: "Test", userId: customUserId })],
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

    it("includes all nutrient keys, with null for undefined nutrients", () => {
      const entries = buildDailyEntries(
        [makeRow({ name: "Test", calories: 10, proteinG: 5 })],
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
