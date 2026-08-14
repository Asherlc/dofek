import { describe, expect, it, vi } from "vitest";
import { DailyTotals, FoodEntry, FoodRepository } from "./food-repository.ts";

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

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("FoodRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new FoodRepository({ execute }, "user-1", "UTC");
    return { repo, execute };
  }

  describe("list", () => {
    it("returns food entries", async () => {
      const { repo } = makeRepository([makeFoodEntryRow()]);
      const result = await repo.list("2024-06-01", "2024-06-30");
      expect(result[0]).toBeInstanceOf(FoodEntry);
    });

    it("filters by meal", async () => {
      const { repo } = makeRepository([makeFoodEntryRow({ meal: "dinner" })]);
      const result = await repo.list("2024-06-01", "2024-06-30", "dinner");
      expect(result[0]?.meal).toBe("dinner");
    });
  });

  describe("byDate", () => {
    it("returns entries for a date", async () => {
      const { repo } = makeRepository([makeFoodEntryRow()]);
      const result = await repo.byDate("2024-06-15");
      expect(result).toHaveLength(1);
    });
  });

  describe("dailyTotals", () => {
    it("returns daily totals", async () => {
      const { repo } = makeRepository([makeDailyTotalsRow()]);
      const result = await repo.dailyTotals(30);
      expect(result[0]).toBeInstanceOf(DailyTotals);
    });
  });
});

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
