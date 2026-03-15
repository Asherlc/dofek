import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { foodEntry } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import {
  AutoSupplementsProvider,
  buildDailyEntries,
  parseSupplementConfig,
  type SupplementConfig,
} from "./auto-supplements.ts";

// ============================================================
// Coverage tests — validate(), datesInRange(), sync() paths
// Including: sync with DB (lines 240-277), datesInRange iteration (lines 189-191)
// ============================================================

describe("AutoSupplementsProvider — validate()", () => {
  it("returns error when no config is provided", () => {
    const provider = new AutoSupplementsProvider();
    const result = provider.validate();
    expect(result).toContain("No supplement config");
  });

  it("returns null for a valid config", () => {
    const config: SupplementConfig = {
      supplements: [{ name: "Vitamin D", calories: 0 }],
    };
    const provider = new AutoSupplementsProvider(config);
    expect(provider.validate()).toBeNull();
  });

  it("returns validation error for invalid config", () => {
    // Force an invalid config — empty supplements array (violates Zod min(1) at runtime).
    // TypeScript type allows empty array since min(1) is a runtime-only constraint.
    const badConfig: SupplementConfig = { supplements: [] };
    const provider = new AutoSupplementsProvider(badConfig);
    const result = provider.validate();
    expect(result).toContain("Invalid supplement config");
  });
});

describe("AutoSupplementsProvider — sync() edge cases", () => {
  it("returns error when no config during sync", async () => {
    const provider = new AutoSupplementsProvider();
    const mockDb = {} as Parameters<typeof provider.sync>[0];
    const result = await provider.sync(mockDb, new Date());
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("No supplement config");
  });
});

describe("parseSupplementConfig — edge cases", () => {
  it("rejects non-object input", () => {
    expect(() => parseSupplementConfig("not an object")).toThrow();
  });

  it("rejects null input", () => {
    expect(() => parseSupplementConfig(null)).toThrow();
  });

  it("accepts supplement with all nutrient fields", () => {
    const config = {
      supplements: [
        {
          name: "Super Supplement",
          description: "Everything",
          meal: "breakfast" as const,
          calories: 10,
          proteinG: 1,
          carbsG: 2,
          fatG: 0.5,
          saturatedFatG: 0.1,
          polyunsaturatedFatG: 0.2,
          monounsaturatedFatG: 0.1,
          transFatG: 0,
          cholesterolMg: 5,
          sodiumMg: 10,
          potassiumMg: 50,
          fiberG: 0.5,
          sugarG: 0.1,
          vitaminAMcg: 300,
          vitaminCMg: 60,
          vitaminDMcg: 25,
          vitaminEMg: 7.5,
          vitaminKMcg: 60,
          vitaminB1Mg: 0.6,
          vitaminB2Mg: 0.7,
          vitaminB3Mg: 8,
          vitaminB5Mg: 2.5,
          vitaminB6Mg: 0.8,
          vitaminB7Mcg: 15,
          vitaminB9Mcg: 200,
          vitaminB12Mcg: 1.2,
          calciumMg: 500,
          ironMg: 9,
          magnesiumMg: 200,
          zincMg: 5,
          seleniumMcg: 28,
          copperMg: 0.45,
          manganeseMg: 1.2,
          chromiumMcg: 18,
          iodineMcg: 75,
          omega3Mg: 500,
          omega6Mg: 100,
          amount: 2,
          unit: "capsules",
          form: "gelcap",
        },
      ],
    };
    const result = parseSupplementConfig(config);
    expect(result).toHaveLength(1);
    expect(result[0]?.vitaminDMcg).toBe(25);
    expect(result[0]?.omega3Mg).toBe(500);
  });
});

describe("buildDailyEntries — edge cases", () => {
  it("returns empty array for empty dates", () => {
    const entries = buildDailyEntries([{ name: "Test" }], []);
    expect(entries).toHaveLength(0);
  });

  it("returns empty array for empty supplements", () => {
    const entries = buildDailyEntries([], ["2024-03-15"]);
    expect(entries).toHaveLength(0);
  });

  it("sets numberOfUnits to 1 for all entries", () => {
    const entries = buildDailyEntries([{ name: "Test" }], ["2024-03-15"]);
    expect(entries[0]?.numberOfUnits).toBe(1);
  });

  it("sets foodDescription from supplement description", () => {
    const entries = buildDailyEntries(
      [{ name: "Test", description: "2 capsules" }],
      ["2024-03-15"],
    );
    expect(entries[0]?.foodDescription).toBe("2 capsules");
  });

  it("sets foodDescription to undefined when no description", () => {
    const entries = buildDailyEntries([{ name: "Test" }], ["2024-03-15"]);
    expect(entries[0]?.foodDescription).toBeUndefined();
  });

  it("only includes defined nutrient values in nutrients object", () => {
    const entries = buildDailyEntries(
      [{ name: "Test", calories: 10, proteinG: 5 }],
      ["2024-03-15"],
    );
    expect(entries[0]?.nutrients).toEqual({ calories: 10, proteinG: 5 });
    expect(entries[0]?.nutrients.fatG).toBeUndefined();
  });
});

// ============================================================
// Integration tests for sync() with real DB (covers lines 240-277)
// ============================================================

describe("AutoSupplementsProvider — sync() with DB (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("inserts supplement entries into the database", async () => {
    const config: SupplementConfig = {
      supplements: [
        { name: "Vitamin D3", calories: 0, vitaminDMcg: 50 },
        { name: "Fish Oil", calories: 10, omega3Mg: 1000, meal: "breakfast" },
      ],
    };
    const provider = new AutoSupplementsProvider(config);

    // Use a since date that is today so we get exactly 1 day
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const result = await provider.sync(ctx.db, today);

    expect(result.provider).toBe("auto-supplements");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(2);

    // Verify entries in DB
    const rows = await ctx.db
      .select()
      .from(foodEntry)
      .where(eq(foodEntry.providerId, "auto-supplements"));
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const vitD = rows.find((r) => r.foodName === "Vitamin D3");
    expect(vitD).toBeDefined();
    expect(vitD?.category).toBe("supplement");

    const fishOil = rows.find((r) => r.foodName === "Fish Oil");
    expect(fishOil).toBeDefined();
    expect(fishOil?.meal).toBe("breakfast");
  });

  it("upserts on re-sync (updates existing entries)", async () => {
    const config: SupplementConfig = {
      supplements: [{ name: "Magnesium", calories: 0, magnesiumMg: 400 }],
    };
    const provider = new AutoSupplementsProvider(config);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // Sync twice
    await provider.sync(ctx.db, today);
    const result = await provider.sync(ctx.db, today);

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);

    // Verify no duplicates
    const rows = await ctx.db
      .select()
      .from(foodEntry)
      .where(eq(foodEntry.providerId, "auto-supplements"));
    const magCount = rows.filter((r) => r.foodName === "Magnesium").length;
    expect(magCount).toBe(1);
  });

  it("returns empty result when since is in the future (no dates)", async () => {
    const config: SupplementConfig = {
      supplements: [{ name: "Zinc", calories: 0 }],
    };
    const provider = new AutoSupplementsProvider(config);

    const future = new Date("2099-01-01T00:00:00Z");
    const result = await provider.sync(ctx.db, future);

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles multiple days in range", async () => {
    const config: SupplementConfig = {
      supplements: [{ name: "TestMultiDay", calories: 5 }],
    };
    const provider = new AutoSupplementsProvider(config);

    // 3 days ago to today = 4 days
    const threeDaysAgo = new Date();
    threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 3);
    threeDaysAgo.setUTCHours(0, 0, 0, 0);

    const result = await provider.sync(ctx.db, threeDaysAgo);

    expect(result.errors).toHaveLength(0);
    // Should be at least 4 entries (3 days ago, 2 days ago, yesterday, today)
    expect(result.recordsSynced).toBeGreaterThanOrEqual(4);
  });
});
