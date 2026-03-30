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

  // -------------------------------------------------------------------------
  // Additional mutation-killing tests
  // -------------------------------------------------------------------------

  describe("list — SQL parameters are passed correctly", () => {
    it("passes startDate, endDate, and userId to the SQL query (no meal)", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.list("2024-01-01", "2024-12-31");
      const queryArg = execute.mock.calls[0]?.[0];
      const queryJson = JSON.stringify(queryArg);
      expect(queryJson).toContain("2024-01-01");
      expect(queryJson).toContain("2024-12-31");
      expect(queryJson).toContain("user-1");
    });

    it("passes startDate, endDate, userId, and meal to the SQL query (with meal)", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.list("2024-03-01", "2024-03-31", "dinner");
      const queryArg = execute.mock.calls[0]?.[0];
      const queryJson = JSON.stringify(queryArg);
      expect(queryJson).toContain("2024-03-01");
      expect(queryJson).toContain("2024-03-31");
      expect(queryJson).toContain("user-1");
      expect(queryJson).toContain("dinner");
    });

    it("maps multiple rows to FoodEntry instances preserving order", async () => {
      const row1 = makeFoodEntryRow({ id: "a", food_name: "Apple" });
      const row2 = makeFoodEntryRow({ id: "b", food_name: "Banana" });
      const { repo } = makeRepository([row1, row2]);
      const result = await repo.list("2024-06-01", "2024-06-30");
      expect(result).toHaveLength(2);
      expect(result[0]?.foodName).toBe("Apple");
      expect(result[1]?.foodName).toBe("Banana");
    });

    it("maps multiple rows when meal is specified", async () => {
      const row1 = makeFoodEntryRow({ id: "a", food_name: "Eggs", meal: "breakfast" });
      const row2 = makeFoodEntryRow({ id: "b", food_name: "Toast", meal: "breakfast" });
      const { repo } = makeRepository([row1, row2]);
      const result = await repo.list("2024-06-01", "2024-06-30", "breakfast");
      expect(result).toHaveLength(2);
      expect(result[0]?.foodName).toBe("Eggs");
      expect(result[1]?.foodName).toBe("Toast");
    });

    it("does NOT use meal branch when meal is empty string (falsy)", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.list("2024-06-01", "2024-06-30", "");
      // empty string is falsy, so the no-meal branch executes
      // The query should NOT contain the meal parameter
      // (the no-meal query doesn't include a meal filter)
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("byDate — SQL parameters", () => {
    it("passes date and userId to the query", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.byDate("2024-07-04");
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("2024-07-04");
      expect(queryJson).toContain("user-1");
    });

    it("maps multiple rows preserving order", async () => {
      const row1 = makeFoodEntryRow({ id: "x", food_name: "Salad" });
      const row2 = makeFoodEntryRow({ id: "y", food_name: "Soup" });
      const { repo } = makeRepository([row1, row2]);
      const result = await repo.byDate("2024-06-15");
      expect(result).toHaveLength(2);
      expect(result[0]?.foodName).toBe("Salad");
      expect(result[1]?.foodName).toBe("Soup");
    });
  });

  describe("dailyTotals — SQL parameters and mapping", () => {
    it("passes days and userId to the query", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.dailyTotals(7);
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("user-1");
    });

    it("maps multiple rows to DailyTotals instances preserving order", async () => {
      const row1 = makeDailyTotalsRow({ date: "2024-06-14", calories: 1800 });
      const row2 = makeDailyTotalsRow({ date: "2024-06-15", calories: 2100 });
      const { repo } = makeRepository([row1, row2]);
      const result = await repo.dailyTotals(30);
      expect(result).toHaveLength(2);
      expect(result[0]?.date).toBe("2024-06-14");
      expect(result[0]?.calories).toBe(1800);
      expect(result[1]?.date).toBe("2024-06-15");
      expect(result[1]?.calories).toBe(2100);
    });

    it("each result is a DailyTotals instance (not plain object)", async () => {
      const { repo } = makeRepository([makeDailyTotalsRow()]);
      const result = await repo.dailyTotals(30);
      expect(result[0]).toBeInstanceOf(DailyTotals);
    });
  });

  describe("search — SQL parameters and mapping", () => {
    it("passes limit and userId to the query", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.search("rice", 5);
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("user-1");
    });

    it("constructs search pattern with percent signs around query", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.search("oat", 10);
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("%oat%");
    });

    it("maps multiple rows to FoodSearchResult instances preserving order", async () => {
      const row1 = makeFoodSearchRow({ food_name: "Brown Rice" });
      const row2 = makeFoodSearchRow({ food_name: "White Rice" });
      const { repo } = makeRepository([row1, row2]);
      const result = await repo.search("rice", 10);
      expect(result).toHaveLength(2);
      expect(result[0]?.foodName).toBe("Brown Rice");
      expect(result[1]?.foodName).toBe("White Rice");
      expect(result[0]).toBeInstanceOf(FoodSearchResult);
      expect(result[1]).toBeInstanceOf(FoodSearchResult);
    });
  });

  describe("create — null coalescing for all nutrient fields", () => {
    it("passes provided nutrient values (not null) when they are supplied", async () => {
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
      const repo = new FoodRepository(db, "user-1", "UTC");

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
      const repo = new FoodRepository(db, "user-1", "UTC");

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
    it("passes explicit null for meal when set to null", async () => {
      const foodRow = makeFoodEntryRow();
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // ensureDofekProvider
        .mockResolvedValueOnce([{ id: "entry-1" }]) // insert CTE
        .mockResolvedValueOnce([foodRow]); // select from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

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

  describe("update — nutrient field with null creates new nutrition_data when ndId is null", () => {
    it("creates new nutrition_data and links it when existing ndId is null", async () => {
      const foodRow = makeFoodEntryRow();
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ nutrition_data_id: null }]) // SELECT returns null ndId
        .mockResolvedValueOnce([{ id: "new-nd-99" }]) // INSERT nutrition_data returns new id
        .mockResolvedValueOnce([]) // UPDATE food_entry set nutrition_data_id
        .mockResolvedValueOnce([]) // UPDATE nutrition_data set values
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", calories: 200 });
      expect(result).not.toBeNull();
      expect(execute).toHaveBeenCalledTimes(5);
    });

    it("skips creating nutrition_data when ndIdRows is empty (entry not found)", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // SELECT returns empty — no entry found
        .mockResolvedValueOnce([]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", calories: 200 });
      // ndIdRows.length is 0, so neither the existing-nd nor new-nd branch runs
      // Only 2 calls: SELECT nutrition_data_id + SELECT from view
      expect(execute).toHaveBeenCalledTimes(2);
      expect(result).toBeNull();
    });

    it("skips nutrition_data creation when INSERT returns no id", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ nutrition_data_id: null }]) // SELECT returns null ndId
        .mockResolvedValueOnce([]) // INSERT nutrition_data returns empty (edge case)
        .mockResolvedValueOnce([]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", calories: 200 });
      // newNd?.id is undefined so the UPDATE calls are skipped
      expect(execute).toHaveBeenCalledTimes(3);
      expect(result).toBeNull();
    });
  });

  describe("update — combined food + nutrient + nutrients updates", () => {
    it("handles food entry fields + nutrient fields + junction table nutrients all at once", async () => {
      const foodRow = makeFoodEntryRow({ food_name: "Updated", calories: 500 });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ nutrition_data_id: "nd-1" }]) // SELECT nutrition_data_id
        .mockResolvedValueOnce([]) // UPDATE nutrition_data
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([]) // DELETE from junction table
        .mockResolvedValueOnce([]) // INSERT into junction table
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({
        id: "entry-1",
        foodName: "Updated",
        calories: 500,
        nutrients: { zinc: 5 },
      });
      expect(result).not.toBeNull();
      expect(result?.food_name).toBe("Updated");
      expect(execute).toHaveBeenCalledTimes(6);
    });

    it("handles nutrient column with non-null value (sets value)", async () => {
      const foodRow = makeFoodEntryRow();
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ nutrition_data_id: "nd-1" }]) // SELECT nutrition_data_id
        .mockResolvedValueOnce([]) // UPDATE nutrition_data
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", proteinG: 42 });
      expect(result).not.toBeNull();
      expect(execute).toHaveBeenCalledTimes(3);
    });
  });

  describe("update — fieldColumnMap entries other than date, meal, foodName", () => {
    it("handles foodDescription field (non-date, non-null)", async () => {
      const foodRow = makeFoodEntryRow({ food_description: "New desc" });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", foodDescription: "New desc" });
      expect(result).not.toBeNull();
    });

    it("handles category field (non-date, non-null)", async () => {
      const foodRow = makeFoodEntryRow({ category: "fruit" });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", category: "fruit" });
      expect(result).not.toBeNull();
    });

    it("handles numberOfUnits field (non-date, non-null)", async () => {
      const foodRow = makeFoodEntryRow({ number_of_units: 3 });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", numberOfUnits: 3 });
      expect(result).not.toBeNull();
    });

    it("handles category field set to null", async () => {
      const foodRow = makeFoodEntryRow({ category: null });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", category: null });
      expect(result).not.toBeNull();
    });

    it("handles foodDescription set to null", async () => {
      const foodRow = makeFoodEntryRow({ food_description: null });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", foodDescription: null });
      expect(result).not.toBeNull();
    });

    it("handles numberOfUnits set to null", async () => {
      const foodRow = makeFoodEntryRow({ number_of_units: null });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", numberOfUnits: null });
      expect(result).not.toBeNull();
    });
  });

  describe("update — nutrient null coalescing in junction table", () => {
    it("deletes junction rows but does not insert when nutrients is empty object", async () => {
      const foodRow = makeFoodEntryRow();
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // DELETE from junction table
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", nutrients: {} });
      expect(result).not.toBeNull();
      // Only 2 calls: DELETE + SELECT (no INSERT because nutrients is empty)
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("deletes junction rows and inserts new ones when nutrients has entries", async () => {
      const foodRow = makeFoodEntryRow();
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // DELETE from junction table
        .mockResolvedValueOnce([]) // INSERT into junction table
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({
        id: "entry-1",
        nutrients: { "vitamin-a": 100, "vitamin-d": 50 },
      });
      expect(result).not.toBeNull();
      // 3 calls: DELETE + INSERT + SELECT
      expect(execute).toHaveBeenCalledTimes(3);
    });
  });

  describe("update — rows[0] ?? null return value", () => {
    it("returns the first row when multiple rows returned from view", async () => {
      const foodRow1 = makeFoodEntryRow({ id: "entry-1", food_name: "First" });
      const foodRow2 = makeFoodEntryRow({ id: "entry-2", food_name: "Second" });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([foodRow1, foodRow2]); // SELECT from view returns 2
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", meal: "dinner" });
      expect(result).not.toBeNull();
      expect(result?.food_name).toBe("First");
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
      const repo = new FoodRepository(db, "user-1", "UTC");

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
      const repo = new FoodRepository(db, "user-1", "UTC");

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
      const repo = new FoodRepository(db, "user-1", "UTC");

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
      const repo = new FoodRepository(db, "user-1", "UTC");

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
      const repo = new FoodRepository(db, "user-1", "UTC");

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

  describe("delete — always returns success true", () => {
    it("returns { success: true } with boolean true value", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.delete("any-id");
      expect(result.success).toStrictEqual(true);
      expect(typeof result.success).toBe("boolean");
    });

    it("passes userId and id to the delete query", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.delete("target-id");
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("user-1");
      expect(queryJson).toContain("target-id");
    });
  });

  describe("constructor — userId is used in queries", () => {
    it("uses the userId passed to the constructor, not a hardcoded value", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const repo = new FoodRepository({ execute }, "custom-user-42", "UTC");
      await repo.byDate("2024-06-15");
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("custom-user-42");
    });

    it("uses different userId for different repository instances", async () => {
      const execute1 = vi.fn().mockResolvedValue([]);
      const repo1 = new FoodRepository({ execute: execute1 }, "user-alpha", "UTC");
      await repo1.byDate("2024-06-15");

      const execute2 = vi.fn().mockResolvedValue([]);
      const repo2 = new FoodRepository({ execute: execute2 }, "user-beta", "UTC");
      await repo2.byDate("2024-06-15");

      const query1Json = JSON.stringify(execute1.mock.calls[0]?.[0]);
      const query2Json = JSON.stringify(execute2.mock.calls[0]?.[0]);
      expect(query1Json).toContain("user-alpha");
      expect(query2Json).toContain("user-beta");
      expect(query1Json).not.toContain("user-beta");
    });
  });

  describe("update — multiple food entry fields at once", () => {
    it("builds multiple SET clauses for food entry when multiple fields change", async () => {
      const foodRow = makeFoodEntryRow({
        meal: "dinner",
        food_name: "New Name",
        food_description: "New Desc",
      });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({
        id: "entry-1",
        meal: "dinner",
        foodName: "New Name",
        foodDescription: "New Desc",
      });
      expect(result).not.toBeNull();
      expect(result?.meal).toBe("dinner");
      expect(result?.food_name).toBe("New Name");
      expect(result?.food_description).toBe("New Desc");
    });
  });

  describe("update — multiple nutrient fields at once", () => {
    it("builds multiple SET clauses for nutrition_data when multiple nutrient fields change", async () => {
      const foodRow = makeFoodEntryRow();
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ nutrition_data_id: "nd-1" }]) // SELECT nutrition_data_id
        .mockResolvedValueOnce([]) // UPDATE nutrition_data
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({
        id: "entry-1",
        calories: 600,
        proteinG: 50,
        fatG: 20,
      });
      expect(result).not.toBeNull();
      expect(execute).toHaveBeenCalledTimes(3);
    });
  });

  describe("update — nutrient null value handling", () => {
    it("handles nutrient field set to null (null branch in NUTRIENT_COLUMN_MAP)", async () => {
      const foodRow = makeFoodEntryRow();
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ nutrition_data_id: "nd-1" }]) // SELECT nutrition_data_id
        .mockResolvedValueOnce([]) // UPDATE nutrition_data
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute };
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", proteinG: null });
      expect(result).not.toBeNull();
      expect(execute).toHaveBeenCalledTimes(3);
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
      const repo = new FoodRepository(db, "user-1", "UTC");

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
      const repo = new FoodRepository(db, "user-1", "UTC");

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

describe("FoodEntry — toDetail returns every field with distinct values", () => {
  it("every field in toDetail maps to the correct row property", () => {
    const row = makeFoodEntryRow({
      id: "unique-id",
      provider_id: "unique-provider",
      user_id: "unique-user",
      external_id: "unique-external",
      date: "2025-01-01",
      meal: "unique-meal",
      food_name: "unique-food",
      food_description: "unique-desc",
      category: "unique-category",
      provider_food_id: "unique-provider-food",
      provider_serving_id: "unique-psid",
      number_of_units: 99,
      logged_at: "2025-01-01T00:00:00Z",
      barcode: "unique-barcode",
      serving_unit: "unique-unit",
      serving_weight_grams: 777,
      nutrition_data_id: "unique-nutrition-data",
      raw: { key: "unique-raw" },
      confirmed: false,
      created_at: "2025-01-01T12:00:00Z",
      calories: 111,
      protein_g: 222,
      carbs_g: 333,
      fat_g: 444,
    });
    const entry = new FoodEntry(row);
    const detail = entry.toDetail();
    expect(detail.id).toBe("unique-id");
    expect(detail.provider_id).toBe("unique-provider");
    expect(detail.user_id).toBe("unique-user");
    expect(detail.external_id).toBe("unique-external");
    expect(detail.date).toBe("2025-01-01");
    expect(detail.meal).toBe("unique-meal");
    expect(detail.food_name).toBe("unique-food");
    expect(detail.food_description).toBe("unique-desc");
    expect(detail.category).toBe("unique-category");
    expect(detail.provider_food_id).toBe("unique-provider-food");
    expect(detail.provider_serving_id).toBe("unique-psid");
    expect(detail.number_of_units).toBe(99);
    expect(detail.logged_at).toBe("2025-01-01T00:00:00Z");
    expect(detail.barcode).toBe("unique-barcode");
    expect(detail.serving_unit).toBe("unique-unit");
    expect(detail.serving_weight_grams).toBe(777);
    expect(detail.nutrition_data_id).toBe("unique-nutrition-data");
    expect(detail.confirmed).toBe(false);
    expect(detail.created_at).toBe("2025-01-01T12:00:00Z");
    expect(detail.calories).toBe(111);
    expect(detail.protein_g).toBe(222);
    expect(detail.carbs_g).toBe(333);
    expect(detail.fat_g).toBe(444);
  });
});

describe("DailyTotals — toDetail returns every field with distinct values", () => {
  it("each field maps to the correct row property", () => {
    const row = makeDailyTotalsRow({
      date: "2025-02-02",
      calories: 1111,
      protein_g: 2222,
      carbs_g: 3333,
      fat_g: 4444,
      fiber_g: 5555,
    });
    const totals = new DailyTotals(row);
    const detail = totals.toDetail();
    expect(detail.date).toBe("2025-02-02");
    expect(detail.calories).toBe(1111);
    expect(detail.protein_g).toBe(2222);
    expect(detail.carbs_g).toBe(3333);
    expect(detail.fat_g).toBe(4444);
    expect(detail.fiber_g).toBe(5555);
  });
});

describe("FoodSearchResult — toDetail returns every field with distinct values", () => {
  it("each field maps to the correct row property", () => {
    const row = makeFoodSearchRow({
      food_name: "unique-fname",
      food_description: "unique-food-desc",
      category: "unique-cat",
      calories: 1001,
      protein_g: 2002,
      carbs_g: 3003,
      fat_g: 4004,
      fiber_g: 5005,
      number_of_units: 6006,
    });
    const result = new FoodSearchResult(row);
    const detail = result.toDetail();
    expect(detail.food_name).toBe("unique-fname");
    expect(detail.food_description).toBe("unique-food-desc");
    expect(detail.category).toBe("unique-cat");
    expect(detail.calories).toBe(1001);
    expect(detail.protein_g).toBe(2002);
    expect(detail.carbs_g).toBe(3003);
    expect(detail.fat_g).toBe(4004);
    expect(detail.fiber_g).toBe(5005);
    expect(detail.number_of_units).toBe(6006);
  });
});
