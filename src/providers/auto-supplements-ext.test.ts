import { describe, expect, it } from "vitest";
import {
  AutoSupplementsProvider,
  buildDailyEntries,
  parseSupplementConfig,
  type SupplementConfig,
  type SupplementDefinition,
} from "./auto-supplements.ts";

// ============================================================
// Extended coverage tests for auto-supplements provider
// Focus on: datesInRange (lines 181-194), sync flow (lines 233-277)
// ============================================================

describe("datesInRange — via buildDailyEntries and sync", () => {
  // datesInRange is private, but we can test it indirectly through sync
  it("sync returns empty results when since is in the future", async () => {
    const config: SupplementConfig = {
      supplements: [{ name: "Vitamin D", vitaminDMcg: 50 }],
    };
    const provider = new AutoSupplementsProvider(config);

    // since is far in the future — no dates in range
    const futureDate = new Date("2099-12-31T00:00:00Z");
    const mockDb = {} as Parameters<typeof provider.sync>[0];
    const result = await provider.sync(mockDb, futureDate);

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe("buildDailyEntries — multi-date multi-supplement", () => {
  it("creates cartesian product of supplements x dates", () => {
    const supplements: SupplementDefinition[] = [
      { name: "Vitamin D", vitaminDMcg: 50 },
      { name: "Omega 3", omega3Mg: 1000 },
      { name: "Magnesium", magnesiumMg: 400 },
    ];
    const dates = ["2024-03-01", "2024-03-02"];

    const entries = buildDailyEntries(supplements, dates);
    expect(entries).toHaveLength(6); // 3 supplements * 2 dates
  });

  it("generates correct externalIds with slugified names", () => {
    const supplements: SupplementDefinition[] = [
      { name: "Vitamin D3 5000IU" },
      { name: "Fish Oil (EPA/DHA)" },
    ];
    const dates = ["2024-03-01"];

    const entries = buildDailyEntries(supplements, dates);
    // Slugify: lowercase, replace non-alphanumeric with hyphens, trim hyphens
    expect(entries[0]?.externalId).toBe("auto:vitamin-d3-5000iu:2024-03-01");
    expect(entries[1]?.externalId).toBe("auto:fish-oil-epa-dha:2024-03-01");
  });

  it("uses default meal 'other' when not specified", () => {
    const entries = buildDailyEntries([{ name: "Test" }], ["2024-03-01"]);
    expect(entries[0]?.meal).toBe("other");
  });

  it("uses specified meal", () => {
    const entries = buildDailyEntries(
      [{ name: "Morning Vitamin", meal: "breakfast" }],
      ["2024-03-01"],
    );
    expect(entries[0]?.meal).toBe("breakfast");
  });

  it("sets category to supplement for all entries", () => {
    const entries = buildDailyEntries([{ name: "Test" }], ["2024-03-01"]);
    expect(entries[0]?.category).toBe("supplement");
  });

  it("includes all provided nutrients in the nutrients object", () => {
    const supplements: SupplementDefinition[] = [
      {
        name: "Multi",
        calories: 5,
        vitaminDMcg: 50,
        vitaminB12Mcg: 2.4,
        omega3Mg: 500,
        ironMg: 8,
        calciumMg: 1000,
        zincMg: 11,
        seleniumMcg: 55,
      },
    ];

    const entries = buildDailyEntries(supplements, ["2024-03-01"]);
    const nutrients = entries[0]?.nutrients;
    expect(nutrients?.calories).toBe(5);
    expect(nutrients?.vitaminDMcg).toBe(50);
    expect(nutrients?.vitaminB12Mcg).toBe(2.4);
    expect(nutrients?.omega3Mg).toBe(500);
    expect(nutrients?.ironMg).toBe(8);
    expect(nutrients?.calciumMg).toBe(1000);
    expect(nutrients?.zincMg).toBe(11);
    expect(nutrients?.seleniumMcg).toBe(55);
  });

  it("sets providerId to auto-supplements", () => {
    const entries = buildDailyEntries([{ name: "Test" }], ["2024-03-01"]);
    expect(entries[0]?.providerId).toBe("auto-supplements");
  });
});

describe("parseSupplementConfig — extended validation", () => {
  it("rejects config with missing name", () => {
    expect(() => parseSupplementConfig({ supplements: [{ description: "no name" }] })).toThrow();
  });

  it("rejects config with empty name", () => {
    expect(() => parseSupplementConfig({ supplements: [{ name: "" }] })).toThrow();
  });

  it("rejects config with invalid meal value", () => {
    expect(() =>
      parseSupplementConfig({
        supplements: [{ name: "Test", meal: "brunch" }],
      }),
    ).toThrow();
  });

  it("accepts all valid meal values", () => {
    for (const meal of ["breakfast", "lunch", "dinner", "snack", "other"]) {
      const result = parseSupplementConfig({
        supplements: [{ name: "Test", meal }],
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.meal).toBe(meal);
    }
  });

  it("accepts supplement with only name (all nutrients optional)", () => {
    const result = parseSupplementConfig({
      supplements: [{ name: "Plain" }],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("Plain");
  });

  it("parses multiple supplements", () => {
    const result = parseSupplementConfig({
      supplements: [
        { name: "Vitamin D", vitaminDMcg: 50 },
        { name: "Fish Oil", omega3Mg: 1000, omega6Mg: 200 },
      ],
    });
    expect(result).toHaveLength(2);
  });
});

describe("AutoSupplementsProvider — extended", () => {
  it("provider id and name are correct", () => {
    const provider = new AutoSupplementsProvider();
    expect(provider.id).toBe("auto-supplements");
    expect(provider.name).toBe("Auto-Supplements");
  });

  it("validate returns null for config with supplement metadata fields", () => {
    const config: SupplementConfig = {
      supplements: [
        {
          name: "Creatine",
          amount: 5,
          unit: "g",
          form: "monohydrate powder",
        },
      ],
    };
    const provider = new AutoSupplementsProvider(config);
    expect(provider.validate()).toBeNull();
  });
});
