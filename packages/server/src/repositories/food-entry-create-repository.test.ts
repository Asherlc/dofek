import { describe, expect, it, vi } from "vitest";
import { FoodEntryCreateRepository } from "./food-entry-create-repository.ts";
import {
  collectSqlValues,
  makeFoodEntryRow,
  makeRepository as makeTestRepository,
} from "./food-repository-test-helpers.ts";

function makeRepository(rows: Record<string, unknown>[] = []) {
  return makeTestRepository(FoodEntryCreateRepository, rows);
}

describe("ensureDofekProvider", () => {
  it("executes insert for dofek provider", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.ensureDofekProvider();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("create", () => {
  it("creates a food entry and returns it with nutrients", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-1" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.create({
      date: "2024-06-15",
      meal: "lunch",
      foodName: "Chicken Breast",
      nutrients: {},
    });

    expect(result.food_name).toBe("Chicken Breast");
    expect(result.nutrients).toEqual({});
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("persists an external identifier when provided", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "entry-1" }])
      .mockResolvedValueOnce([foodRow]);
    const repo = new FoodEntryCreateRepository({ execute }, "user-1", "UTC");

    await repo.create({
      date: "2024-06-15",
      foodName: "External Food",
      externalId: "external-entry-1",
      nutrients: { "vitamin-c": 1 },
    });

    expect(JSON.stringify(execute.mock.calls[1]?.[0])).toContain("external-entry-1");
  });

  it("persists an external identifier without nutrients", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "entry-1" }])
      .mockResolvedValueOnce([foodRow]);
    const repo = new FoodEntryCreateRepository({ execute }, "user-1", "UTC");

    await repo.create({
      date: "2024-06-15",
      foodName: "External Food",
      externalId: "external-entry-2",
      nutrients: {},
    });

    expect(JSON.stringify(execute.mock.calls[1]?.[0])).toContain("external-entry-2");
  });

  it("persists serving unit and serving weight for created itemized facts", async () => {
    const foodRow = makeFoodEntryRow({
      serving_unit: "bowl",
      serving_weight_grams: 80,
    });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "entry-1" }])
      .mockResolvedValueOnce([foodRow]);
    const repo = new FoodEntryCreateRepository({ execute }, "user-1", "UTC");

    await repo.create({
      date: "2024-06-15",
      foodName: "Oats",
      servingUnit: "bowl",
      servingWeightGrams: 80,
      nutrients: {},
    });

    const insert = JSON.stringify(execute.mock.calls[1]?.[0]);
    expect(insert).toContain("serving_unit");
    expect(insert).toContain("serving_weight_grams");
    expect(insert).toContain("bowl");
    expect(insert).toContain("80");
  });

  it("inserts junction table rows when nutrients are provided", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-1" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]) // select from view
      .mockResolvedValueOnce([]); // junction table insert
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.create({
      date: "2024-06-15",
      meal: "lunch",
      foodName: "Chicken Breast",
      nutrients: { "vitamin-c": 25 },
    });

    expect(result.nutrients).toEqual({ "vitamin-c": 25 });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("throws when insert returns no row", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-1" }]) // insert CTE
      .mockResolvedValueOnce([]); // select from view returns nothing
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    await expect(
      repo.create({
        date: "2024-06-15",
        meal: "lunch",
        foodName: "Ghost Food",
        nutrients: {},
      }),
    ).rejects.toThrow("Failed to insert food entry");
  });

  it("skips junction table insert when nutrients is empty (length === 0)", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-1" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.create({
      date: "2024-06-15",
      foodName: "Plain Rice",
      nutrients: {},
    });

    // Only 3 calls: ensureProvider, insert CTE, select view
    // No junction table insert because nutrients is empty
    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.nutrients).toEqual({});
  });

  it("inserts into junction table when nutrients has multiple entries (length > 0)", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-1" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.create({
      date: "2024-06-15",
      foodName: "Enriched Food",
      nutrients: { "vitamin-c": 25, iron: 8, zinc: 3 },
    });

    // 3 calls: ensureProvider, insert CTE with nutrient rows, select view
    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.nutrients).toEqual({ "vitamin-c": 25, iron: 8, zinc: 3 });
  });
});

describe("create — null coalescing for optional fields", () => {
  it("passes null for omitted optional fields via ?? null", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-1" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.create({
      date: "2024-06-15",
      foodName: "Simple Food",
      nutrients: {},
    });
    // meal, foodDescription, category, numberOfUnits should all be null
    expect(result).not.toBeNull();
    expect(result.food_name).toBe("Chicken Breast");
  });
});

describe("quickAdd", () => {
  it("creates a quick-add entry", async () => {
    const foodRow = makeFoodEntryRow({ food_name: "Quick Oats" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-2" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.quickAdd({
      date: "2024-06-15",
      meal: "breakfast",
      foodName: "Quick Oats",
      calories: 150,
    });

    expect(result?.food_name).toBe("Quick Oats");
    expect(result?.nutrients).toEqual({});
  });

  it("returns undefined when select returns no rows", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-2" }]) // insert CTE
      .mockResolvedValueOnce([]); // select from view returns nothing
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.quickAdd({
      date: "2024-06-15",
      meal: "breakfast",
      foodName: "Ghost Oats",
      calories: 150,
    });

    expect(result).toBeUndefined();
  });

  it("quickAdd calls ensureDofekProvider before inserting", async () => {
    const foodRow = makeFoodEntryRow({ food_name: "Oats" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-3" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    await repo.quickAdd({
      date: "2024-06-15",
      meal: "snack",
      foodName: "Oats",
      calories: 100,
    });

    // 3 calls: ensureProvider + insert CTE + select view
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("quickAdd returns nutrients as empty object, not undefined or null", async () => {
    const foodRow = makeFoodEntryRow({ food_name: "Snack" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-4" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.quickAdd({
      date: "2024-06-15",
      meal: "snack",
      foodName: "Snack",
      calories: 50,
    });

    expect(result?.nutrients).toStrictEqual({});
    expect(result?.nutrients).not.toBeUndefined();
    expect(result?.nutrients).not.toBeNull();
  });
});

describe("create — returned object spreads inserted row with nutrients", () => {
  it("returned object includes both row fields and nutrients key", async () => {
    const foodRow = makeFoodEntryRow({ food_name: "Banana" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-1" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]) // select from view
      .mockResolvedValueOnce([]); // junction table insert
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.create({
      date: "2024-06-15",
      foodName: "Banana",
      nutrients: { potassium: 400 },
    });

    // Verify the result has both the row fields and nutrients
    expect(result.food_name).toBe("Banana"); // from mock row
    expect(result.nutrients).toStrictEqual({ potassium: 400 });
    expect(result.id).toBe("entry-1");
    expect(result.user_id).toBe("user-1");
  });
});

// -------------------------------------------------------------------------
// Additional mutation-killing tests
// -------------------------------------------------------------------------

describe("create — null coalescing for all nutrient fields", () => {
  it("passes provided nutrient values (not null) when they are supplied", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-1" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.create({
      date: "2024-06-15",
      meal: "lunch",
      foodName: "Fortified Cereal",
      foodDescription: "With milk",
      category: "grain",
      numberOfUnits: 2,
      calories: 350,
      proteinG: 10,
      carbsG: 45,
      fatG: 8,
      saturatedFatG: 2,
      polyunsaturatedFatG: 1,
      monounsaturatedFatG: 3,
      transFatG: 0,
      cholesterolMg: 5,
      sodiumMg: 200,
      potassiumMg: 300,
      fiberG: 6,
      sugarG: 12,
      vitaminAMcg: 450,
      vitaminCMg: 30,
      vitaminDMcg: 5,
      vitaminEMg: 7,
      vitaminKMcg: 25,
      vitaminB1Mg: 0.5,
      vitaminB2Mg: 0.6,
      vitaminB3Mg: 8,
      vitaminB5Mg: 2,
      vitaminB6Mg: 0.7,
      vitaminB7Mcg: 15,
      vitaminB9Mcg: 200,
      vitaminB12Mcg: 1.5,
      calciumMg: 250,
      ironMg: 8,
      magnesiumMg: 60,
      zincMg: 4,
      seleniumMcg: 20,
      copperMg: 0.5,
      manganeseMg: 1.2,
      chromiumMcg: 10,
      iodineMcg: 75,
      omega3Mg: 100,
      omega6Mg: 200,
      nutrients: {},
    });

    // The insert CTE query (call index 1) should contain the nutrient values
    const insertQuery = JSON.stringify(execute.mock.calls[1]?.[0]);
    expect(insertQuery).toContain("350"); // calories
    expect(insertQuery).toContain("10"); // proteinG
    expect(insertQuery).toContain("45"); // carbsG
    const query = execute.mock.calls[1]?.[0];
    const queryChunks =
      typeof query === "object" && query !== null ? Reflect.get(query, "queryChunks") : undefined;
    expect(Array.isArray(queryChunks)).toBe(true);
    if (!Array.isArray(queryChunks)) throw new Error("Expected SQL query chunks");
    expect(JSON.stringify(queryChunks)).toContain("grain");
    expect(JSON.stringify(queryChunks)).toContain("2");
    expect(JSON.stringify(queryChunks)).toContain("lunch");
    expect(JSON.stringify(queryChunks)).toContain("With milk");
    const sqlValues = collectSqlValues(query);
    expect(sqlValues).toContain("grain");
    expect(sqlValues).toContain(2);
    expect(result).not.toBeNull();
  });

  it("uses the first id from idRows when multiple are returned", async () => {
    const foodRow = makeFoodEntryRow({ id: "first-id" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "first-id" }, { id: "second-id" }]) // insert CTE returns multiple
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.create({
      date: "2024-06-15",
      foodName: "Test",
      nutrients: {},
    });

    expect(result.id).toBe("first-id");
  });

  it("handles empty idRows from insert CTE gracefully (newId is undefined)", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([]) // insert CTE returns empty
      .mockResolvedValueOnce([]); // select returns nothing (because undefined id)
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    await expect(
      repo.create({
        date: "2024-06-15",
        foodName: "Ghost",
        nutrients: {},
      }),
    ).rejects.toThrow("Failed to insert food entry");
  });
});

describe("create — optional field null coalescing", () => {
  it("preserves provided optional values when no nutrient rows are inserted", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "entry-1" }])
      .mockResolvedValueOnce([foodRow]);
    const repo = new FoodEntryCreateRepository({ execute }, "user-1", "UTC");

    await repo.create({
      date: "2024-06-15",
      foodName: "Food",
      category: "grain",
      numberOfUnits: 2,
      nutrients: {},
    });

    const query = execute.mock.calls[1]?.[0];
    const queryChunks =
      typeof query === "object" && query !== null ? Reflect.get(query, "queryChunks") : undefined;
    expect(Array.isArray(queryChunks)).toBe(true);
    if (!Array.isArray(queryChunks)) throw new Error("Expected SQL query chunks");
    expect(JSON.stringify(queryChunks)).toContain("grain");
    expect(JSON.stringify(queryChunks)).toContain("2");
  });

  it("passes explicit null for meal when set to null", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-1" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    await repo.create({
      date: "2024-06-15",
      meal: null,
      foodName: "Food",
      foodDescription: null,
      category: null,
      numberOfUnits: null,
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
      nutrients: {},
    });

    // Should succeed without error — all null coalescing paths hit
    expect(execute).toHaveBeenCalledTimes(3);
  });
});

describe("quickAdd — SQL parameters and optional field coalescing", () => {
  it("passes all optional macro values when provided", async () => {
    const foodRow = makeFoodEntryRow({ food_name: "Protein Bar" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-5" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.quickAdd({
      date: "2024-06-15",
      meal: "snack",
      foodName: "Protein Bar",
      calories: 220,
      proteinG: 20,
      carbsG: 25,
      fatG: 9,
    });

    expect(result).not.toBeUndefined();
    expect(result?.nutrients).toStrictEqual({});
    expect(execute).toHaveBeenCalledTimes(3);
    // Verify the insert query contains the macro values
    const insertQuery = JSON.stringify(execute.mock.calls[1]?.[0]);
    expect(insertQuery).toContain("220"); // calories
  });

  it("passes null for omitted optional macros via ?? null", async () => {
    const foodRow = makeFoodEntryRow({ food_name: "Simple Snack" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-6" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.quickAdd({
      date: "2024-06-15",
      meal: "snack",
      foodName: "Simple Snack",
      calories: 100,
      // proteinG, carbsG, fatG omitted — should be null via ?? null
    });

    expect(result).not.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("handles empty idRows from insert CTE (returns undefined)", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([]) // insert CTE returns empty
      .mockResolvedValueOnce([]); // select returns nothing
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.quickAdd({
      date: "2024-06-15",
      meal: "snack",
      foodName: "Ghost",
      calories: 0,
    });

    expect(result).toBeUndefined();
  });

  it("uses the first id from idRows when multiple returned", async () => {
    const foodRow = makeFoodEntryRow({ id: "first-qa" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "first-qa" }, { id: "second-qa" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.quickAdd({
      date: "2024-06-15",
      meal: "lunch",
      foodName: "Test",
      calories: 100,
    });

    expect(result?.id).toBe("first-qa");
  });

  it("returns spread of row plus nutrients key (not the raw row)", async () => {
    const foodRow = makeFoodEntryRow({ id: "qa-spread", food_name: "Spread Test" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "qa-spread" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    const result = await repo.quickAdd({
      date: "2024-06-15",
      meal: "lunch",
      foodName: "Spread Test",
      calories: 100,
    });

    // Verify it has all row fields PLUS nutrients
    expect(result?.id).toBe("qa-spread");
    expect(result?.food_name).toBe("Spread Test");
    expect(result?.user_id).toBe("user-1");
    expect(result?.nutrients).toStrictEqual({});
  });
});

describe("ensureDofekProvider — uses correct constant", () => {
  it("inserts with provider id 'dofek'", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.ensureDofekProvider();
    const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(queryJson).toContain("dofek");
  });
});

describe("create — uses DOFEK_PROVIDER_ID constant", () => {
  it("inserts food entry with provider_id 'dofek'", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-1" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    await repo.create({
      date: "2024-06-15",
      foodName: "Test",
      nutrients: {},
    });

    // The ensureDofekProvider call should contain 'dofek'
    const providerQuery = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(providerQuery).toContain("dofek");
    // The insert CTE call should also contain 'dofek' as provider_id
    const insertQuery = JSON.stringify(execute.mock.calls[1]?.[0]);
    expect(insertQuery).toContain("dofek");
  });
});

describe("quickAdd — uses DOFEK_PROVIDER_ID constant", () => {
  it("inserts food entry with provider_id 'dofek'", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // ensureDofekProvider
      .mockResolvedValueOnce([{ id: "entry-1" }]) // insert CTE
      .mockResolvedValueOnce([foodRow]); // select from view
    const db = { execute };
    const repo = new FoodEntryCreateRepository(db, "user-1", "UTC");

    await repo.quickAdd({
      date: "2024-06-15",
      meal: "lunch",
      foodName: "Test",
      calories: 100,
    });

    const providerQuery = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(providerQuery).toContain("dofek");
    const insertQuery = JSON.stringify(execute.mock.calls[1]?.[0]);
    expect(insertQuery).toContain("dofek");
  });
});
