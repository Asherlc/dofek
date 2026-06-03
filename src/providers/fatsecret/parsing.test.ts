import { describe, expect, it } from "vitest";
import {
  type FatSecretFoodEntriesResponse,
  fatSecretFoodEntriesResponseSchema,
  inferCategory,
  parseFoodEntries,
} from "./parsing.ts";

const singleEntryResponse: FatSecretFoodEntriesResponse = {
  food_entries: {
    food_entry: [
      {
        food_entry_id: "12345",
        food_entry_name: "Oatmeal",
        food_entry_description: "1 cup, cooked",
        food_id: "1234",
        serving_id: "5678",
        number_of_units: "1.000",
        meal: "Breakfast",
        date_int: "19797", // 2024-03-15
        calories: "158",
        carbohydrate: "27.40",
        protein: "5.90",
        fat: "3.20",
        saturated_fat: "0.54",
        polyunsaturated_fat: "1.12",
        monounsaturated_fat: "0.99",
        cholesterol: "0",
        sodium: "115",
        potassium: "143",
        fiber: "4.00",
        sugar: "0.60",
        vitamin_a: "0",
        vitamin_c: "0.0",
        calcium: "163",
        iron: "6.32",
      },
    ],
  },
};

describe("parseFoodEntries", () => {
  it("parses a single entry with all nutrients mapped and converted", () => {
    const entries = parseFoodEntries(singleEntryResponse);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) throw new Error("expected entry");
    expect(entry.externalId).toBe("12345");
    expect(entry.foodName).toBe("Oatmeal");
    expect(entry.foodDescription).toBe("1 cup, cooked");
    expect(entry.fatsecretFoodId).toBe("1234");
    expect(entry.fatsecretServingId).toBe("5678");
    expect(entry.numberOfUnits).toBeCloseTo(1.0);
    expect(entry.meal).toBe("breakfast");
    expect(entry.date).toBe("2024-03-15");
    expect(entry.calories).toBe(158);
    expect(entry.proteinG).toBeCloseTo(5.9);
    expect(entry.carbsG).toBeCloseTo(27.4);
    expect(entry.fatG).toBeCloseTo(3.2);
    expect(entry.saturatedFatG).toBeCloseTo(0.54);
    expect(entry.polyunsaturatedFatG).toBeCloseTo(1.12);
    expect(entry.monounsaturatedFatG).toBeCloseTo(0.99);
    expect(entry.cholesterolMg).toBeCloseTo(0);
    expect(entry.sodiumMg).toBeCloseTo(115);
    expect(entry.potassiumMg).toBeCloseTo(143);
    expect(entry.fiberG).toBeCloseTo(4.0);
    expect(entry.sugarG).toBeCloseTo(0.6);
    expect(entry.vitaminAMcg).toBeCloseTo(0);
    expect(entry.vitaminCMg).toBeCloseTo(0);
    expect(entry.calciumMg).toBeCloseTo(163);
    expect(entry.ironMg).toBeCloseTo(6.32);
  });

  it("preserves decimal calories instead of truncating them", () => {
    const response: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [
          {
            food_entry_id: "decimal-calories",
            food_entry_name: "Olive Oil",
            food_entry_description: "1 tsp",
            food_id: "9000",
            serving_id: "9001",
            number_of_units: "1.000",
            meal: "Dinner",
            date_int: "19797",
            calories: "158.5",
            carbohydrate: "0",
            protein: "0",
            fat: "18",
          },
        ],
      },
    };
    expect(parseFoodEntries(response)[0]?.calories).toBe(158.5);
  });

  it("parses multiple entries and normalizes meal names", () => {
    const response: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [
          {
            food_entry_id: "11111",
            food_entry_name: "Scrambled Eggs",
            food_entry_description: "2 large",
            food_id: "2222",
            serving_id: "3333",
            number_of_units: "2.000",
            meal: "Breakfast",
            date_int: "19797",
            calories: "182",
            carbohydrate: "2.40",
            protein: "12.10",
            fat: "13.80",
          },
          {
            food_entry_id: "11112",
            food_entry_name: "Chicken Breast",
            food_entry_description: "6 oz",
            food_id: "4444",
            serving_id: "5555",
            number_of_units: "1.000",
            meal: "Lunch",
            date_int: "19797",
            calories: "280",
            carbohydrate: "0.00",
            protein: "52.00",
            fat: "6.20",
          },
        ],
      },
    };
    const entries = parseFoodEntries(response);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.meal).toBe("breakfast");
    expect(entries[1]?.meal).toBe("lunch");
  });

  it("leaves missing optional nutrients undefined", () => {
    const response: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [
          {
            food_entry_id: "99",
            food_entry_name: "Water",
            food_entry_description: "1 glass",
            food_id: "f50",
            serving_id: "s50",
            number_of_units: "1",
            meal: "Snack",
            date_int: "19783",
            calories: "0",
            carbohydrate: "0",
            protein: "0",
            fat: "0",
          },
        ],
      },
    };
    const entries = parseFoodEntries(response);
    expect(entries[0]?.meal).toBe("snack");
    expect(entries[0]?.saturatedFatG).toBeUndefined();
    expect(entries[0]?.cholesterolMg).toBeUndefined();
    expect(entries[0]?.vitaminAMcg).toBeUndefined();
  });

  it("maps unknown meal names to 'other'", () => {
    const response: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [
          {
            food_entry_id: "1",
            food_entry_name: "Toast",
            food_entry_description: "1 slice",
            food_id: "10",
            serving_id: "20",
            number_of_units: "1.000",
            meal: "Second Breakfast",
            date_int: "20000",
            calories: "80",
            carbohydrate: "14",
            protein: "3",
            fat: "1",
          },
        ],
      },
    };
    expect(parseFoodEntries(response)[0]?.meal).toBe("other");
  });

  it("converts date_int (days since epoch) to an ISO date", () => {
    expect(parseFoodEntries(singleEntryResponse)[0]?.date).toBe("2024-03-15");

    const dayZero: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [
          {
            food_entry_id: "0",
            food_entry_name: "Test",
            food_entry_description: "test",
            food_id: "1",
            serving_id: "1",
            number_of_units: "1.000",
            meal: "Lunch",
            date_int: "0",
            calories: "0",
            carbohydrate: "0",
            protein: "0",
            fat: "0",
          },
        ],
      },
    };
    expect(parseFoodEntries(dayZero)[0]?.date).toBe("1970-01-01");
  });

  it("returns an empty array for empty, missing, or null food_entries", () => {
    expect(parseFoodEntries({ food_entries: { food_entry: [] } })).toEqual([]);
    expect(parseFoodEntries(Object.create(null))).toEqual([]);
    expect(parseFoodEntries({ food_entries: Object.create(null) })).toEqual([]);
    expect(parseFoodEntries({ food_entries: null })).toEqual([]);
  });
});

describe("inferCategory", () => {
  it("detects supplement keywords (case-insensitive)", () => {
    for (const name of [
      "Vitamin D3",
      "Fish Oil Softgels",
      "Omega-3 Capsules",
      "Creatine Monohydrate",
      "Collagen Peptides",
      "Whey Protein Isolate",
      "Probiotic Daily",
      "Magnesium Glycinate",
      "Ashwagandha Root Extract",
      "Multivitamin Complete",
      "BCAA Powder",
      "Electrolyte Mix",
      "Turmeric Curcumin",
      "Zinc Picolinate",
      "fish oil",
      "VITAMIN C",
    ]) {
      expect(inferCategory(name)).toBe("supplement");
    }
  });

  it("detects dosage patterns (mg, mcg, IU)", () => {
    expect(inferCategory("CoQ10 200mg")).toBe("supplement");
    expect(inferCategory("B12 1000mcg")).toBe("supplement");
    expect(inferCategory("D3 5000IU")).toBe("supplement");
    expect(inferCategory("Something 500 mg")).toBe("supplement");
  });

  it("returns undefined for regular foods, including ones with non-dosage numbers", () => {
    for (const name of [
      "Scrambled Eggs",
      "Chicken Breast",
      "Oatmeal",
      "Greek Yogurt",
      "2% Milk",
      "100 Calorie Snack Pack",
    ]) {
      expect(inferCategory(name)).toBeUndefined();
    }
  });
});

describe("fatSecretFoodEntriesResponseSchema", () => {
  it("accepts an empty-day response with no food_entries key", () => {
    const result = fatSecretFoodEntriesResponseSchema.parse({});
    expect(result.food_entries).toBeUndefined();
    expect(parseFoodEntries(result)).toHaveLength(0);
  });

  it("accepts food_entries: null", () => {
    const result = fatSecretFoodEntriesResponseSchema.parse({ food_entries: null });
    expect(result.food_entries).toBeNull();
  });

  it("accepts a populated response", () => {
    const result = fatSecretFoodEntriesResponseSchema.parse(singleEntryResponse);
    expect(result.food_entries?.food_entry).toHaveLength(1);
  });

  it("rejects a response whose food_entry is missing required fields", () => {
    expect(() =>
      fatSecretFoodEntriesResponseSchema.parse({
        food_entries: { food_entry: [{ food_entry_id: "1" }] },
      }),
    ).toThrow();
  });
});
