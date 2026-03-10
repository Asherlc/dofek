import { describe, expect, it } from "vitest";
import {
  buildOAuth1Header,
  type FatSecretFoodEntriesResponse,
  inferCategory,
  parseFoodEntries,
} from "../fatsecret.js";

// ============================================================
// Sample API responses (based on FatSecret Platform API docs)
// ============================================================

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

const multiEntryResponse: FatSecretFoodEntriesResponse = {
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
        saturated_fat: "4.20",
        polyunsaturated_fat: "2.70",
        monounsaturated_fat: "5.20",
        cholesterol: "370",
        sodium: "342",
        potassium: "132",
        fiber: "0.00",
        sugar: "1.40",
        vitamin_a: "172",
        vitamin_c: "0.2",
        calcium: "66",
        iron: "1.46",
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

const emptyResponse: FatSecretFoodEntriesResponse = {
  food_entries: {
    food_entry: [],
  },
};

// ============================================================
// Tests
// ============================================================

describe("FatSecret Provider", () => {
  describe("parseFoodEntries", () => {
    it("parses a single food entry with full nutrients", () => {
      const entries = parseFoodEntries(singleEntryResponse);
      expect(entries).toHaveLength(1);

      const entry = entries[0];
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

    it("parses multiple entries", () => {
      const entries = parseFoodEntries(multiEntryResponse);
      expect(entries).toHaveLength(2);
      expect(entries[0].meal).toBe("breakfast");
      expect(entries[1].meal).toBe("lunch");
      expect(entries[0].foodName).toBe("Scrambled Eggs");
      expect(entries[1].foodName).toBe("Chicken Breast");
    });

    it("handles entries with missing optional nutrients", () => {
      const entries = parseFoodEntries(multiEntryResponse);
      const chicken = entries[1];
      expect(chicken.calories).toBe(280);
      expect(chicken.proteinG).toBeCloseTo(52.0);
      expect(chicken.saturatedFatG).toBeUndefined();
      expect(chicken.cholesterolMg).toBeUndefined();
      expect(chicken.sodiumMg).toBeUndefined();
      expect(chicken.fiberG).toBeUndefined();
    });

    it("returns empty array for empty response", () => {
      const entries = parseFoodEntries(emptyResponse);
      expect(entries).toHaveLength(0);
    });

    it("converts date_int to ISO date string", () => {
      const entries = parseFoodEntries(singleEntryResponse);
      // 19797 days since epoch = 2024-03-15
      expect(entries[0].date).toBe("2024-03-15");
    });

    it("normalizes meal names to lowercase", () => {
      const entries = parseFoodEntries(singleEntryResponse);
      expect(entries[0].meal).toBe("breakfast");
    });
  });

  describe("inferCategory", () => {
    it("identifies common supplement keywords", () => {
      expect(inferCategory("Vitamin D3 5000 IU")).toBe("supplement");
      expect(inferCategory("Fish Oil Capsules")).toBe("supplement");
      expect(inferCategory("Creatine Monohydrate")).toBe("supplement");
      expect(inferCategory("Magnesium Glycinate 400mg")).toBe("supplement");
      expect(inferCategory("Whey Protein Powder")).toBe("supplement");
      expect(inferCategory("Zinc 50mg Tablet")).toBe("supplement");
      expect(inferCategory("Multivitamin")).toBe("supplement");
      expect(inferCategory("Probiotic Capsule")).toBe("supplement");
      expect(inferCategory("Omega-3 Softgel")).toBe("supplement");
      expect(inferCategory("Ashwagandha Extract")).toBe("supplement");
      expect(inferCategory("Collagen Peptides")).toBe("supplement");
    });

    it("does not flag regular foods as supplements", () => {
      expect(inferCategory("Scrambled Eggs")).toBeUndefined();
      expect(inferCategory("Chicken Breast")).toBeUndefined();
      expect(inferCategory("Oatmeal")).toBeUndefined();
      expect(inferCategory("Orange Juice")).toBeUndefined();
      expect(inferCategory("Salmon Fillet")).toBeUndefined();
      expect(inferCategory("Greek Yogurt")).toBeUndefined();
    });

    it("handles case-insensitive matching", () => {
      expect(inferCategory("VITAMIN C")).toBe("supplement");
      expect(inferCategory("fish oil")).toBe("supplement");
    });

    it("matches dosage patterns (mg, mcg, IU)", () => {
      expect(inferCategory("CoQ10 200mg")).toBe("supplement");
      expect(inferCategory("B12 1000mcg")).toBe("supplement");
      expect(inferCategory("D3 5000IU")).toBe("supplement");
    });
  });

  describe("buildOAuth1Header", () => {
    it("produces a valid Authorization header", () => {
      const header = buildOAuth1Header(
        "GET",
        "https://platform.fatsecret.com/rest/server.api",
        { method: "food_entries.get.v2", date: "19814", format: "json" },
        {
          consumerKey: "test-consumer-key",
          consumerSecret: "test-consumer-secret",
          token: "test-token",
          tokenSecret: "test-token-secret",
        },
      );

      expect(header).toMatch(/^OAuth /);
      expect(header).toContain('oauth_consumer_key="test-consumer-key"');
      expect(header).toContain('oauth_token="test-token"');
      expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
      expect(header).toContain('oauth_version="1.0"');
      expect(header).toContain("oauth_nonce=");
      expect(header).toContain("oauth_timestamp=");
      expect(header).toContain("oauth_signature=");
    });

    it("produces different nonces on each call", () => {
      const params = {
        consumerKey: "k",
        consumerSecret: "s",
        token: "t",
        tokenSecret: "ts",
      };
      const h1 = buildOAuth1Header("GET", "https://example.com", {}, params);
      const h2 = buildOAuth1Header("GET", "https://example.com", {}, params);

      const nonce1 = h1.match(/oauth_nonce="([^"]+)"/)?.[1];
      const nonce2 = h2.match(/oauth_nonce="([^"]+)"/)?.[1];
      expect(nonce1).not.toBe(nonce2);
    });
  });
});
