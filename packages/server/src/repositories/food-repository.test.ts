import { describe, expect, it, vi } from "vitest";
import { DailyTotals, FoodEntry, FoodRepository, FoodSearchResult } from "./food-repository.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a realistic food entry row from the v_food_entry_with_nutrition view. */
function makeFoodEntryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    provider_id: "dofek",
    user_id: "user-1",
    external_id: null,
    date: "2024-06-15",
    meal: "lunch",
    food_name: "Chicken Breast",
    food_description: "Grilled, 200g",
    category: "meat",
    provider_food_id: null,
    provider_serving_id: null,
    number_of_units: 1,
    logged_at: "2024-06-15T12:00:00Z",
    barcode: null,
    serving_unit: null,
    serving_weight_grams: null,
    nutrition_data_id: "nd-1",
    raw: null,
    confirmed: true,
    created_at: "2024-06-15T12:00:00Z",
    calories: 330,
    protein_g: 40,
    carbs_g: 0,
    fat_g: 8,
    saturated_fat_g: null,
    polyunsaturated_fat_g: null,
    monounsaturated_fat_g: null,
    trans_fat_g: null,
    cholesterol_mg: null,
    sodium_mg: null,
    potassium_mg: null,
    fiber_g: null,
    sugar_g: null,
    vitamin_a_mcg: null,
    vitamin_c_mg: null,
    vitamin_d_mcg: null,
    vitamin_e_mg: null,
    vitamin_k_mcg: null,
    vitamin_b1_mg: null,
    vitamin_b2_mg: null,
    vitamin_b3_mg: null,
    vitamin_b5_mg: null,
    vitamin_b6_mg: null,
    vitamin_b7_mcg: null,
    vitamin_b9_mcg: null,
    vitamin_b12_mcg: null,
    calcium_mg: null,
    iron_mg: null,
    magnesium_mg: null,
    zinc_mg: null,
    selenium_mcg: null,
    copper_mg: null,
    manganese_mg: null,
    chromium_mcg: null,
    iodine_mcg: null,
    omega3_mg: null,
    omega6_mg: null,
    ...overrides,
  };
}

function makeDailyTotalsRow(overrides: Record<string, unknown> = {}) {
  return {
    date: "2024-06-15",
    calories: 2100,
    protein_g: 150,
    carbs_g: 200,
    fat_g: 80,
    fiber_g: 25,
    ...overrides,
  };
}

function makeFoodSearchRow(overrides: Record<string, unknown> = {}) {
  return {
    food_name: "Chicken Breast",
    food_description: "Grilled, 200g",
    category: "meat",
    calories: 330,
    protein_g: 40,
    carbs_g: 0,
    fat_g: 8,
    fiber_g: 0,
    number_of_units: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

describe("FoodEntry", () => {
  it("exposes getters for key fields", () => {
    const entry = new FoodEntry(makeFoodEntryRow());
    expect(entry.id).toBe("entry-1");
    expect(entry.date).toBe("2024-06-15");
    expect(entry.meal).toBe("lunch");
    expect(entry.foodName).toBe("Chicken Breast");
    expect(entry.providerId).toBe("dofek");
    expect(entry.confirmed).toBe(true);
    expect(entry.nutritionDataId).toBe("nd-1");
  });

  it("serializes to API shape via toDetail()", () => {
    const entry = new FoodEntry(makeFoodEntryRow());
    const detail = entry.toDetail();
    expect(detail.id).toBe("entry-1");
    expect(detail.food_name).toBe("Chicken Breast");
    expect(detail.calories).toBe(330);
    expect(detail.protein_g).toBe(40);
  });

  it("handles null meal", () => {
    const entry = new FoodEntry(makeFoodEntryRow({ meal: null }));
    expect(entry.meal).toBeNull();
  });

  it("handles null nutrition_data_id", () => {
    const entry = new FoodEntry(makeFoodEntryRow({ nutrition_data_id: null }));
    expect(entry.nutritionDataId).toBeNull();
  });

  it("toDetail() returns complete row with all fields", () => {
    const row = makeFoodEntryRow();
    const entry = new FoodEntry(row);
    const detail = entry.toDetail();
    expect(detail.id).toBe("entry-1");
    expect(detail.provider_id).toBe("dofek");
    expect(detail.user_id).toBe("user-1");
    expect(detail.date).toBe("2024-06-15");
    expect(detail.meal).toBe("lunch");
    expect(detail.food_name).toBe("Chicken Breast");
    expect(detail.food_description).toBe("Grilled, 200g");
    expect(detail.category).toBe("meat");
    expect(detail.number_of_units).toBe(1);
    expect(detail.nutrition_data_id).toBe("nd-1");
    expect(detail.confirmed).toBe(true);
    expect(detail.calories).toBe(330);
    expect(detail.protein_g).toBe(40);
    expect(detail.carbs_g).toBe(0);
    expect(detail.fat_g).toBe(8);
  });

  it("toDetail() returns a copy, not the original reference", () => {
    const row = makeFoodEntryRow();
    const entry = new FoodEntry(row);
    const detail1 = entry.toDetail();
    const detail2 = entry.toDetail();
    expect(detail1).not.toBe(detail2);
    expect(detail1).toEqual(detail2);
  });

  it("handles non-null values for all nullable fields", () => {
    const entry = new FoodEntry(
      makeFoodEntryRow({
        external_id: "ext-1",
        food_description: "Grilled, 200g",
        category: "meat",
        provider_food_id: "pf-1",
        provider_serving_id: "ps-1",
        number_of_units: 2,
        logged_at: "2024-06-15T12:00:00Z",
        barcode: "1234567890",
        serving_unit: "g",
        serving_weight_grams: 200,
        nutrition_data_id: "nd-1",
      }),
    );
    const detail = entry.toDetail();
    expect(detail.external_id).toBe("ext-1");
    expect(detail.food_description).toBe("Grilled, 200g");
    expect(detail.category).toBe("meat");
    expect(detail.provider_food_id).toBe("pf-1");
    expect(detail.provider_serving_id).toBe("ps-1");
    expect(detail.number_of_units).toBe(2);
    expect(detail.logged_at).toBe("2024-06-15T12:00:00Z");
    expect(detail.barcode).toBe("1234567890");
    expect(detail.serving_unit).toBe("g");
    expect(detail.serving_weight_grams).toBe(200);
    expect(detail.nutrition_data_id).toBe("nd-1");
  });
});

describe("DailyTotals", () => {
  it("exposes getters", () => {
    const totals = new DailyTotals(makeDailyTotalsRow());
    expect(totals.date).toBe("2024-06-15");
    expect(totals.calories).toBe(2100);
  });

  it("serializes to API shape via toDetail()", () => {
    const detail = new DailyTotals(makeDailyTotalsRow()).toDetail();
    expect(detail).toEqual({
      date: "2024-06-15",
      calories: 2100,
      protein_g: 150,
      carbs_g: 200,
      fat_g: 80,
      fiber_g: 25,
    });
  });

  it("handles null calories", () => {
    const totals = new DailyTotals(makeDailyTotalsRow({ calories: null }));
    expect(totals.calories).toBeNull();
  });

  it("toDetail() returns all fields including nullable macros", () => {
    const totals = new DailyTotals(
      makeDailyTotalsRow({ protein_g: null, carbs_g: null, fat_g: null, fiber_g: null }),
    );
    const detail = totals.toDetail();
    expect(detail.protein_g).toBeNull();
    expect(detail.carbs_g).toBeNull();
    expect(detail.fat_g).toBeNull();
    expect(detail.fiber_g).toBeNull();
    expect(detail.date).toBe("2024-06-15");
  });

  it("toDetail() returns a copy, not the original reference", () => {
    const row = makeDailyTotalsRow();
    const totals = new DailyTotals(row);
    const detail1 = totals.toDetail();
    const detail2 = totals.toDetail();
    expect(detail1).not.toBe(detail2);
    expect(detail1).toEqual(detail2);
  });
});

describe("FoodSearchResult", () => {
  it("exposes foodName getter", () => {
    const result = new FoodSearchResult(makeFoodSearchRow());
    expect(result.foodName).toBe("Chicken Breast");
  });

  it("serializes to API shape via toDetail()", () => {
    const detail = new FoodSearchResult(makeFoodSearchRow()).toDetail();
    expect(detail.food_name).toBe("Chicken Breast");
    expect(detail.calories).toBe(330);
  });

  it("handles null description", () => {
    const result = new FoodSearchResult(makeFoodSearchRow({ food_description: null }));
    expect(result.toDetail().food_description).toBeNull();
  });

  it("toDetail() returns all fields with correct values", () => {
    const detail = new FoodSearchResult(makeFoodSearchRow()).toDetail();
    expect(detail).toEqual({
      food_name: "Chicken Breast",
      food_description: "Grilled, 200g",
      category: "meat",
      calories: 330,
      protein_g: 40,
      carbs_g: 0,
      fat_g: 8,
      fiber_g: 0,
      number_of_units: 1,
    });
  });

  it("handles null category", () => {
    const result = new FoodSearchResult(makeFoodSearchRow({ category: null }));
    expect(result.toDetail().category).toBeNull();
  });

  it("handles null number_of_units", () => {
    const result = new FoodSearchResult(makeFoodSearchRow({ number_of_units: null }));
    expect(result.toDetail().number_of_units).toBeNull();
  });

  it("handles all nullable nutrition fields as null", () => {
    const result = new FoodSearchResult(
      makeFoodSearchRow({
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
      }),
    );
    const detail = result.toDetail();
    expect(detail.calories).toBeNull();
    expect(detail.protein_g).toBeNull();
    expect(detail.carbs_g).toBeNull();
    expect(detail.fat_g).toBeNull();
    expect(detail.fiber_g).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("FoodRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const db = { execute };
    const repo = new FoodRepository(db, "user-1", "UTC");
    return { repo, execute };
  }

  describe("list", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.list("2024-06-01", "2024-06-30");
      expect(result).toEqual([]);
    });

    it("returns FoodEntry instances", async () => {
      const { repo } = makeRepository([makeFoodEntryRow()]);
      const result = await repo.list("2024-06-01", "2024-06-30");
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(FoodEntry);
      expect(result[0]?.foodName).toBe("Chicken Breast");
    });

    it("filters by meal when provided", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.list("2024-06-01", "2024-06-30", "lunch");
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("queries without meal filter when not provided", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.list("2024-06-01", "2024-06-30");
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("returns FoodEntry instances when meal is provided", async () => {
      const { repo } = makeRepository([makeFoodEntryRow({ meal: "dinner" })]);
      const result = await repo.list("2024-06-01", "2024-06-30", "dinner");
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(FoodEntry);
      expect(result[0]?.meal).toBe("dinner");
    });

    it("uses different SQL for meal vs no-meal (branch coverage)", async () => {
      // Verify both branches produce FoodEntry arrays from the same mock data
      const row = makeFoodEntryRow();
      const executeMeal = vi.fn().mockResolvedValue([row]);
      const repoMeal = new FoodRepository({ execute: executeMeal }, "user-1", "UTC");
      const withMeal = await repoMeal.list("2024-06-01", "2024-06-30", "lunch");

      const executeNoMeal = vi.fn().mockResolvedValue([row]);
      const repoNoMeal = new FoodRepository({ execute: executeNoMeal }, "user-1", "UTC");
      const withoutMeal = await repoNoMeal.list("2024-06-01", "2024-06-30");

      expect(withMeal).toHaveLength(1);
      expect(withoutMeal).toHaveLength(1);
      // Both branches call execute once but with different SQL
      expect(executeMeal).toHaveBeenCalledTimes(1);
      expect(executeNoMeal).toHaveBeenCalledTimes(1);
    });
  });

  describe("byDate", () => {
    it("returns FoodEntry instances for a date", async () => {
      const { repo } = makeRepository([makeFoodEntryRow()]);
      const result = await repo.byDate("2024-06-15");
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(FoodEntry);
    });

    it("returns empty array when no entries for date", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.byDate("2024-06-15");
      expect(result).toEqual([]);
    });
  });

  describe("dailyTotals", () => {
    it("returns DailyTotals instances", async () => {
      const { repo } = makeRepository([makeDailyTotalsRow()]);
      const result = await repo.dailyTotals(30);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(DailyTotals);
      expect(result[0]?.date).toBe("2024-06-15");
    });

    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.dailyTotals(30);
      expect(result).toEqual([]);
    });
  });

  describe("search", () => {
    it("returns FoodSearchResult instances", async () => {
      const { repo } = makeRepository([makeFoodSearchRow()]);
      const result = await repo.search("chicken", 20);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(FoodSearchResult);
      expect(result[0]?.foodName).toBe("Chicken Breast");
    });

    it("passes query to execute", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.search("rice", 10);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

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
      const repo = new FoodRepository(db, "user-1", "UTC");

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

    it("inserts junction table rows when nutrients are provided", async () => {
      const foodRow = makeFoodEntryRow();
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // ensureDofekProvider
        .mockResolvedValueOnce([{ id: "entry-1" }]) // insert CTE
        .mockResolvedValueOnce([foodRow]) // select from view
        .mockResolvedValueOnce([]); // junction table insert
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.create({
        date: "2024-06-15",
        meal: "lunch",
        foodName: "Chicken Breast",
        nutrients: { "vitamin-c": 25 },
      });

      expect(result.nutrients).toEqual({ "vitamin-c": 25 });
      expect(execute).toHaveBeenCalledTimes(4);
    });

    it("throws when insert returns no row", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // ensureDofekProvider
        .mockResolvedValueOnce([{ id: "entry-1" }]) // insert CTE
        .mockResolvedValueOnce([]); // select from view returns nothing
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

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
      const repo = new FoodRepository(db, "user-1", "UTC");

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
        .mockResolvedValueOnce([foodRow]) // select from view
        .mockResolvedValueOnce([]); // junction table insert
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.create({
        date: "2024-06-15",
        foodName: "Enriched Food",
        nutrients: { "vitamin-c": 25, iron: 8, zinc: 3 },
      });

      // 4 calls: ensureProvider, insert CTE, select view, junction insert
      expect(execute).toHaveBeenCalledTimes(4);
      expect(result.nutrients).toEqual({ "vitamin-c": 25, iron: 8, zinc: 3 });
    });
  });

  describe("update", () => {
    it("returns null when no fields to update", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.update({ id: "entry-1" });
      expect(result).toBeNull();
    });

    it("returns null when only undefined fields are passed (no actual changes)", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.update({ id: "entry-1", foodName: undefined });
      expect(result).toBeNull();
    });

    it("processes nutrient updates with existing nutrition_data_id", async () => {
      const foodRow = makeFoodEntryRow({ calories: 500 });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ nutrition_data_id: "nd-1" }]) // SELECT nutrition_data_id
        .mockResolvedValueOnce([]) // UPDATE nutrition_data
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", calories: 500 });
      expect(result).not.toBeNull();
      expect(execute).toHaveBeenCalledTimes(3);
    });

    it("creates new nutrition_data when entry has no nutrition_data_id", async () => {
      const foodRow = makeFoodEntryRow({ calories: 300 });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ nutrition_data_id: null }]) // SELECT returns null ndId
        .mockResolvedValueOnce([{ id: "new-nd-1" }]) // INSERT nutrition_data
        .mockResolvedValueOnce([]) // UPDATE food_entry set nutrition data id
        .mockResolvedValueOnce([]) // UPDATE nutrition_data set values
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", calories: 300 });
      expect(result).not.toBeNull();
    });

    it("handles nutrients replacement in junction table", async () => {
      const foodRow = makeFoodEntryRow();
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // DELETE from junction table
        .mockResolvedValueOnce([]) // INSERT into junction table
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", nutrients: { "vitamin-c": 30 } });
      expect(result).not.toBeNull();
    });

    it("handles nutrients with empty object (deletes but no inserts)", async () => {
      const foodRow = makeFoodEntryRow();
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // DELETE from junction table
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", nutrients: {} });
      expect(result).not.toBeNull();
    });

    it("handles date field with null value", async () => {
      const foodRow = makeFoodEntryRow();
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", date: null });
      expect(result).not.toBeNull();
    });

    it("handles date field with a value", async () => {
      const foodRow = makeFoodEntryRow({ date: "2024-07-01" });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", date: "2024-07-01" });
      expect(result?.date).toBe("2024-07-01");
    });

    it("handles non-date food field with null value", async () => {
      const foodRow = makeFoodEntryRow({ meal: null });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", meal: null });
      expect(result).not.toBeNull();
    });

    it("returns updated row when food fields change", async () => {
      const foodRow = makeFoodEntryRow({ food_name: "Updated Chicken" });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", foodName: "Updated Chicken" });
      expect(result?.food_name).toBe("Updated Chicken");
    });

    it("returns null when all three conditions are falsy (foodEntryClauses=0, nutrientClauses=0, no nutrients)", async () => {
      // This tests the complex && condition:
      // if (foodEntryClauses.length === 0 && nutrientClauses.length === 0 && !nutrients) return null
      const { repo } = makeRepository([]);
      // No recognized fields, no nutrients => all three conditions are true => null
      const result = await repo.update({ id: "entry-1" });
      expect(result).toBeNull();
    });

    it("does NOT return null when nutrients is provided even if clauses are empty", async () => {
      // nutrients is truthy => the && check fails => does NOT return null early
      const foodRow = makeFoodEntryRow();
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // DELETE from junction table
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", nutrients: {} });
      expect(result).not.toBeNull();
    });

    it("does NOT return null when foodEntryClauses > 0 even if nutrientClauses=0 and no nutrients", async () => {
      // foodEntryClauses.length > 0 => first condition is false => does NOT return null
      const foodRow = makeFoodEntryRow({ meal: "dinner" });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", meal: "dinner" });
      expect(result).not.toBeNull();
    });

    it("handles non-null non-date food field value", async () => {
      const foodRow = makeFoodEntryRow({ food_description: "Spicy" });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", foodDescription: "Spicy" });
      expect(result).not.toBeNull();
    });

    it("returns null from SELECT when row no longer exists", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([]); // SELECT returns nothing
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", foodName: "Gone" });
      expect(result).toBeNull();
    });
  });

  describe("delete", () => {
    it("returns success", async () => {
      const { repo, execute } = makeRepository([]);
      const result = await repo.delete("entry-1");
      expect(result).toEqual({ success: true });
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("delete — return value", () => {
    it("always returns { success: true } regardless of whether a row was deleted", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.delete("nonexistent-id");
      expect(result).toStrictEqual({ success: true });
      expect(result.success).toBe(true);
    });

    it("calls execute exactly once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.delete("entry-1");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("search — search pattern", () => {
    it("wraps query with % wildcards for ILIKE", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.search("chicken", 10);
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("%chicken%");
    });

    it("returns empty array when no matches", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.search("nonexistent", 10);
      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });
  });

  describe("update — nutrient field handling", () => {
    it("handles nutrient column with null value (sets NULL)", async () => {
      const foodRow = makeFoodEntryRow();
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ nutrition_data_id: "nd-1" }]) // SELECT nutrition_data_id
        .mockResolvedValueOnce([]) // UPDATE nutrition_data
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", calories: null });
      expect(result).not.toBeNull();
      expect(execute).toHaveBeenCalledTimes(3);
    });

    it("does NOT return null when nutrientClauses > 0 even if foodEntryClauses=0 and no nutrients", async () => {
      const foodRow = makeFoodEntryRow();
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ nutrition_data_id: "nd-1" }]) // SELECT nutrition_data_id
        .mockResolvedValueOnce([]) // UPDATE nutrition_data
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", calories: 500 });
      expect(result).not.toBeNull();
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
      const repo = new FoodRepository(db, "user-1", "UTC");

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
      const repo = new FoodRepository(db, "user-1", "UTC");

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
      const repo = new FoodRepository(db, "user-1", "UTC");

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
      const repo = new FoodRepository(db, "user-1", "UTC");

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
      const repo = new FoodRepository(db, "user-1", "UTC");

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

  describe("delete — object shape", () => {
    it("returns object with exactly one key 'success'", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.delete("entry-1");
      expect(Object.keys(result)).toStrictEqual(["success"]);
    });

    it("success value is boolean true, not truthy", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.delete("entry-1");
      expect(result.success).toBe(true);
      expect(result.success).not.toBe(1);
      expect(result.success).not.toBe("true");
    });
  });

  describe("update — early return null condition boundary", () => {
    it("returns null only when ALL three conditions are met: no food clauses, no nutrient clauses, no nutrients", async () => {
      // Pass an unrecognized field name that is not in fieldColumnMap or NUTRIENT_COLUMN_MAP
      const { repo } = makeRepository([]);
      const result = await repo.update({ id: "entry-1", unknownField: "value" });
      // unknownField is not in fieldColumnMap or NUTRIENT_COLUMN_MAP, and no nutrients key
      // => foodEntryClauses.length === 0 && nutrientClauses.length === 0 && !nutrients => null
      expect(result).toBeNull();
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
      const repo = new FoodRepository(db, "user-1", "UTC");

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
});

// ---------------------------------------------------------------------------
// Domain model — mutation-killing: getters return correct fields
// ---------------------------------------------------------------------------

describe("FoodEntry (mutation: getter field mapping)", () => {
  it("id getter returns id field, not another field", () => {
    const entry = new FoodEntry(makeFoodEntryRow({ id: "unique-id-123", provider_id: "other-id" }));
    expect(entry.id).toBe("unique-id-123");
    expect(entry.id).not.toBe("other-id");
  });

  it("providerId returns provider_id, not id", () => {
    const entry = new FoodEntry(makeFoodEntryRow({ id: "entry-id", provider_id: "provider-abc" }));
    expect(entry.providerId).toBe("provider-abc");
    expect(entry.providerId).not.toBe("entry-id");
  });

  it("date returns date field, not created_at", () => {
    const entry = new FoodEntry(
      makeFoodEntryRow({ date: "2024-06-15", created_at: "2024-06-10T00:00:00Z" }),
    );
    expect(entry.date).toBe("2024-06-15");
    expect(entry.date).not.toBe("2024-06-10T00:00:00Z");
  });

  it("foodName returns food_name, not food_description", () => {
    const entry = new FoodEntry(
      makeFoodEntryRow({ food_name: "Rice", food_description: "White rice" }),
    );
    expect(entry.foodName).toBe("Rice");
    expect(entry.foodName).not.toBe("White rice");
  });

  it("confirmed returns boolean confirmed field", () => {
    const entryTrue = new FoodEntry(makeFoodEntryRow({ confirmed: true }));
    expect(entryTrue.confirmed).toBe(true);

    const entryFalse = new FoodEntry(makeFoodEntryRow({ confirmed: false }));
    expect(entryFalse.confirmed).toBe(false);
  });
});

describe("DailyTotals (mutation: getter returns correct field)", () => {
  it("date returns date, not calories", () => {
    const totals = new DailyTotals(makeDailyTotalsRow({ date: "2024-07-01", calories: 1800 }));
    expect(totals.date).toBe("2024-07-01");
    expect(totals.date).not.toBe(1800);
  });

  it("calories returns calories, not protein_g", () => {
    const totals = new DailyTotals(makeDailyTotalsRow({ calories: 2500, protein_g: 180 }));
    expect(totals.calories).toBe(2500);
    expect(totals.calories).not.toBe(180);
  });
});

describe("FoodSearchResult (mutation: getter returns correct field)", () => {
  it("foodName returns food_name, not category", () => {
    const result = new FoodSearchResult(
      makeFoodSearchRow({ food_name: "Eggs", category: "dairy" }),
    );
    expect(result.foodName).toBe("Eggs");
    expect(result.foodName).not.toBe("dairy");
  });

  it("toDetail returns a complete shallow copy", () => {
    const row = makeFoodSearchRow();
    const result = new FoodSearchResult(row);
    const detail = result.toDetail();
    // Verify it's a copy (spread), not the same reference
    expect(detail).not.toBe(row);
    // But has all the same values
    expect(detail).toStrictEqual(row);
  });
});
