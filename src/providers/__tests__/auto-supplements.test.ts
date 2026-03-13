import { describe, expect, it } from "vitest";
import {
  buildDailyEntries,
  parseSupplementConfig,
  type SupplementConfig,
  type SupplementDefinition,
} from "../auto-supplements.ts";

// ============================================================
// Sample configs
// ============================================================

const sampleConfig: SupplementConfig = {
  supplements: [
    {
      name: "Vitamin D3 5000 IU",
      description: "1 softgel",
      meal: "breakfast",
      calories: 0,
    },
    {
      name: "Fish Oil",
      description: "2 softgels",
      meal: "breakfast",
      calories: 25,
      fatG: 2.5,
      saturatedFatG: 0.5,
      polyunsaturatedFatG: 1.5,
      monounsaturatedFatG: 0.5,
      cholesterolMg: 10,
    },
    {
      name: "Creatine Monohydrate",
      description: "5g powder",
      meal: "breakfast",
      calories: 0,
    },
    {
      name: "Magnesium Glycinate 400mg",
      description: "2 capsules",
      meal: "dinner",
      calories: 0,
      calciumMg: 5,
      ironMg: 0.1,
    },
  ],
};

// ============================================================
// Tests
// ============================================================

describe("Auto-Supplements Provider", () => {
  describe("parseSupplementConfig", () => {
    it("validates a correct config", () => {
      const result = parseSupplementConfig(sampleConfig);
      expect(result).toHaveLength(4);
      expect(result[0]?.name).toBe("Vitamin D3 5000 IU");
      expect(result[3]?.name).toBe("Magnesium Glycinate 400mg");
    });

    it("rejects config with empty supplements array", () => {
      expect(() => parseSupplementConfig({ supplements: [] })).toThrow();
    });

    it("rejects supplement without name", () => {
      expect(() =>
        parseSupplementConfig({
          supplements: [{ description: "1 softgel" } as SupplementDefinition],
        }),
      ).toThrow();
    });

    it("rejects supplement with invalid meal", () => {
      expect(() =>
        parseSupplementConfig({
          supplements: [{ name: "Test", meal: "midnight_snack" as "breakfast" }],
        }),
      ).toThrow();
    });

    it("defaults optional nutritional fields to undefined", () => {
      const result = parseSupplementConfig({
        supplements: [{ name: "Zinc 50mg", description: "1 tablet" }],
      });
      expect(result[0]?.calories).toBeUndefined();
      expect(result[0]?.fatG).toBeUndefined();
      expect(result[0]?.proteinG).toBeUndefined();
    });
  });

  describe("buildDailyEntries", () => {
    it("generates entries for a single date", () => {
      const entries = buildDailyEntries(sampleConfig.supplements, ["2024-03-15"]);
      expect(entries).toHaveLength(4);
      entries.forEach((e) => {
        expect(e.date).toBe("2024-03-15");
        expect(e.category).toBe("supplement");
        expect(e.providerId).toBe("auto-supplements");
      });
    });

    it("generates entries for multiple dates", () => {
      const entries = buildDailyEntries(sampleConfig.supplements, ["2024-03-15", "2024-03-16"]);
      expect(entries).toHaveLength(8); // 4 supplements × 2 days
    });

    it("generates stable externalIds from name + date", () => {
      const entries = buildDailyEntries(sampleConfig.supplements, ["2024-03-15"]);
      const vitD = entries.find((e) => e.foodName === "Vitamin D3 5000 IU");
      expect(vitD?.externalId).toBe("auto:vitamin-d3-5000-iu:2024-03-15");
    });

    it("maps all nutritional fields from supplement definition", () => {
      const entries = buildDailyEntries(sampleConfig.supplements, ["2024-03-15"]);
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

    it("assigns correct meal from supplement definition", () => {
      const entries = buildDailyEntries(sampleConfig.supplements, ["2024-03-15"]);
      const vitD = entries.find((e) => e.foodName === "Vitamin D3 5000 IU");
      const mag = entries.find((e) => e.foodName === "Magnesium Glycinate 400mg");
      expect(vitD?.meal).toBe("breakfast");
      expect(mag?.meal).toBe("dinner");
    });

    it("defaults meal to other when not specified", () => {
      const entries = buildDailyEntries(
        [{ name: "Zinc 50mg", description: "1 tablet" }],
        ["2024-03-15"],
      );
      expect(entries[0]?.meal).toBe("other");
    });

    it("slugifies names consistently for externalId", () => {
      const entries = buildDailyEntries(
        [{ name: "CoQ10 200mg (Ubiquinol)", description: "1 softgel" }],
        ["2024-03-15"],
      );
      expect(entries[0]?.externalId).toBe("auto:coq10-200mg-ubiquinol:2024-03-15");
    });
  });
});
