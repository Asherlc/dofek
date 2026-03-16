import { describe, expect, it } from "vitest";
import {
  buildOAuth1Header,
  type FatSecretFoodEntriesResponse,
  inferCategory,
  parseFoodEntries,
} from "./fatsecret.ts";

// ============================================================
// Tests targeting uncovered paths in fatsecret.ts
// ============================================================

describe("inferCategory", () => {
  it("detects supplement keywords", () => {
    expect(inferCategory("Vitamin D3 5000IU")).toBe("supplement");
    expect(inferCategory("Fish Oil Softgels")).toBe("supplement");
    expect(inferCategory("Omega-3 Capsules")).toBe("supplement");
    expect(inferCategory("Creatine Monohydrate")).toBe("supplement");
    expect(inferCategory("Collagen Peptides")).toBe("supplement");
    expect(inferCategory("Whey Protein Isolate")).toBe("supplement");
    expect(inferCategory("Probiotic Daily")).toBe("supplement");
    expect(inferCategory("Magnesium Glycinate")).toBe("supplement");
    expect(inferCategory("Ashwagandha Root Extract")).toBe("supplement");
    expect(inferCategory("Multivitamin Complete")).toBe("supplement");
    expect(inferCategory("BCAA Powder")).toBe("supplement");
    expect(inferCategory("Electrolyte Mix")).toBe("supplement");
    expect(inferCategory("Melatonin 5mg")).toBe("supplement");
    expect(inferCategory("Turmeric Curcumin")).toBe("supplement");
    expect(inferCategory("CoQ10 200mg")).toBe("supplement");
    expect(inferCategory("Zinc Picolinate")).toBe("supplement");
  });

  it("detects dosage patterns", () => {
    expect(inferCategory("Something 500mg")).toBe("supplement");
    expect(inferCategory("Something 1000mcg")).toBe("supplement");
    expect(inferCategory("Something 5000IU")).toBe("supplement");
  });

  it("returns undefined for regular food", () => {
    expect(inferCategory("Chicken Breast")).toBeUndefined();
    expect(inferCategory("Brown Rice")).toBeUndefined();
    expect(inferCategory("Apple")).toBeUndefined();
    expect(inferCategory("Greek Yogurt")).toBeUndefined();
  });
});

describe("parseFoodEntries", () => {
  it("returns empty array for missing food_entries", () => {
    const response = { food_entries: { food_entry: [] } };
    expect(parseFoodEntries(response)).toEqual([]);
  });

  it("parses a complete food entry", () => {
    const response: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [
          {
            food_entry_id: "12345",
            food_entry_name: "Chicken Breast",
            food_entry_description: "4 oz grilled",
            food_id: "f100",
            serving_id: "s200",
            number_of_units: "1.000",
            meal: "Lunch",
            date_int: "19783", // some days since epoch
            calories: "165",
            carbohydrate: "0",
            protein: "31",
            fat: "3.6",
            saturated_fat: "1.0",
            polyunsaturated_fat: "0.8",
            monounsaturated_fat: "1.2",
            cholesterol: "85",
            sodium: "74",
            potassium: "256",
            fiber: "0",
            sugar: "0",
            vitamin_a: "2",
            vitamin_c: "0",
            calcium: "6",
            iron: "0.5",
          },
        ],
      },
    };

    const entries = parseFoodEntries(response);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.externalId).toBe("12345");
    expect(entry?.foodName).toBe("Chicken Breast");
    expect(entry?.fatsecretFoodId).toBe("f100");
    expect(entry?.fatsecretServingId).toBe("s200");
    expect(entry?.numberOfUnits).toBe(1);
    expect(entry?.meal).toBe("lunch");
    expect(entry?.calories).toBe(165);
    expect(entry?.proteinG).toBe(31);
    expect(entry?.carbsG).toBe(0);
    expect(entry?.fatG).toBe(3.6);
    expect(entry?.saturatedFatG).toBe(1.0);
    expect(entry?.polyunsaturatedFatG).toBe(0.8);
    expect(entry?.monounsaturatedFatG).toBe(1.2);
    expect(entry?.cholesterolMg).toBe(85);
    expect(entry?.sodiumMg).toBe(74);
    expect(entry?.potassiumMg).toBe(256);
    expect(entry?.fiberG).toBe(0);
    expect(entry?.sugarG).toBe(0);
    expect(entry?.vitaminAMcg).toBe(2);
    expect(entry?.vitaminCMg).toBe(0);
    expect(entry?.calciumMg).toBe(6);
    expect(entry?.ironMg).toBe(0.5);
  });

  it("handles missing optional fields", () => {
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
    expect(entries).toHaveLength(1);
    expect(entries[0]?.saturatedFatG).toBeUndefined();
    expect(entries[0]?.cholesterolMg).toBeUndefined();
    expect(entries[0]?.vitaminAMcg).toBeUndefined();
    expect(entries[0]?.meal).toBe("snack");
  });

  it("normalizes unknown meal types to other", () => {
    const response: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [
          {
            food_entry_id: "1",
            food_entry_name: "Snack",
            food_entry_description: "desc",
            food_id: "f1",
            serving_id: "s1",
            number_of_units: "1",
            meal: "Brunch",
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
    expect(entries[0]?.meal).toBe("other");
  });
});

describe("buildOAuth1Header", () => {
  it("returns a string starting with 'OAuth'", () => {
    const creds = {
      consumerKey: "ck",
      consumerSecret: "cs",
      token: "tok",
      tokenSecret: "ts",
    };
    const header = buildOAuth1Header("GET", "https://api.example.com/test", { foo: "bar" }, creds);
    expect(header).toMatch(/^OAuth /);
    expect(header).toContain("oauth_consumer_key=");
    expect(header).toContain("oauth_signature=");
    expect(header).toContain("oauth_token=");
  });
});
