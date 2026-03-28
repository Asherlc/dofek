import { describe, expect, it, vi } from "vitest";
import {
  DailyTotals,
  FoodEntry,
  FoodRepository,
  FoodSearchResult,
} from "./food-repository.ts";

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
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("FoodRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const db = { execute } as unknown as Parameters<typeof FoodRepository extends new (...args: infer P) => unknown ? (...args: P) => void : never>[0];
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
      const db = { execute } as unknown as Parameters<typeof FoodRepository extends new (...args: infer P) => unknown ? (...args: P) => void : never>[0];
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
      const db = { execute } as unknown as Parameters<typeof FoodRepository extends new (...args: infer P) => unknown ? (...args: P) => void : never>[0];
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
      const db = { execute } as unknown as Parameters<typeof FoodRepository extends new (...args: infer P) => unknown ? (...args: P) => void : never>[0];
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
  });

  describe("update", () => {
    it("returns null when no fields to update", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.update({ id: "entry-1" });
      expect(result).toBeNull();
    });

    it("returns updated row when food fields change", async () => {
      const foodRow = makeFoodEntryRow({ food_name: "Updated Chicken" });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // UPDATE food_entry
        .mockResolvedValueOnce([foodRow]); // SELECT from view
      const db = { execute } as unknown as Parameters<typeof FoodRepository extends new (...args: infer P) => unknown ? (...args: P) => void : never>[0];
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.update({ id: "entry-1", foodName: "Updated Chicken" });
      expect(result?.food_name).toBe("Updated Chicken");
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

  describe("quickAdd", () => {
    it("creates a quick-add entry", async () => {
      const foodRow = makeFoodEntryRow({ food_name: "Quick Oats" });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // ensureDofekProvider
        .mockResolvedValueOnce([{ id: "entry-2" }]) // insert CTE
        .mockResolvedValueOnce([foodRow]); // select from view
      const db = { execute } as unknown as Parameters<typeof FoodRepository extends new (...args: infer P) => unknown ? (...args: P) => void : never>[0];
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
      const db = { execute } as unknown as Parameters<typeof FoodRepository extends new (...args: infer P) => unknown ? (...args: P) => void : never>[0];
      const repo = new FoodRepository(db, "user-1", "UTC");

      const result = await repo.quickAdd({
        date: "2024-06-15",
        meal: "breakfast",
        foodName: "Ghost Oats",
        calories: 150,
      });

      expect(result).toBeUndefined();
    });
  });
});
