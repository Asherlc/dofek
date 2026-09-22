import { describe, expect, it } from "vitest";
import { DailyTotals, FoodEntry, FoodSearchResult } from "./food-entry-models.ts";
import {
  availableResolutionRow,
  makeDailyTotalsRow,
  makeFoodEntryRow,
  makeFoodSearchRow,
} from "./food-repository-test-helpers.ts";

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
      ...availableResolutionRow,
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
// Domain model mutation checks

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
