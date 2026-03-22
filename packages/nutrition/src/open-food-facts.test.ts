import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenFoodFactsClient } from "./open-food-facts.ts";

function createFetchResponse(payload: unknown, ok = true) {
  return {
    ok,
    json: async () => payload,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("searchFoods", () => {
  it("adds locale and country filters for US English searches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          {
            code: "2",
            product_name: "Hamburger Buns",
            lang: "en",
            nutriments: { "energy-kcal_100g": 270 },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    await client.searchFoods("hamburger", 5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    const parsedUrl = new URL(requestedUrl);

    expect(parsedUrl.searchParams.get("lc")).toBe("en");
    expect(parsedUrl.searchParams.get("countries_tags_en")).toBe("united-states");
    expect(parsedUrl.searchParams.get("search_terms")).toBe("hamburger");
    expect(parsedUrl.searchParams.get("page_size")).toBe("5");
  });

  it("falls back to global search when country-filtered results are empty", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createFetchResponse({ products: [] }))
      .mockResolvedValueOnce(
        createFetchResponse({
          products: [
            {
              code: "7",
              product_name: "Hamburger Bun",
              lang: "en",
              nutriments: { "energy-kcal_100g": 240 },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    await client.searchFoods("hamburger", 5);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0] ?? ""));
    const secondUrl = new URL(String(fetchMock.mock.calls[1]?.[0] ?? ""));
    expect(firstUrl.searchParams.get("countries_tags_en")).toBe("united-states");
    expect(secondUrl.searchParams.get("countries_tags_en")).toBeNull();
  });

  it("filters out products with a different primary language", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          {
            code: "1",
            product_name: "4 burgers geant",
            lang: "fr",
            nutriments: { "energy-kcal_100g": 250 },
          },
          {
            code: "2",
            product_name: "Hamburger Buns",
            lang: "en",
            nutriments: { "energy-kcal_100g": 270 },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const results = await client.searchFoods("hamburger", 10);

    expect(results).toHaveLength(1);
    expect(results[0]?.barcode).toBe("2");
    expect(results[0]?.name).toBe("Hamburger Buns");
  });

  it("prefers locale-specific product names when available", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          {
            code: "10",
            product_name: "Burger aux graines",
            product_name_en: "Seeded Burger Buns",
            lang: "en",
            nutriments: { "energy-kcal_100g": 300 },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const results = await client.searchFoods("burger", 10);

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("Seeded Burger Buns");
  });
});

describe("lookupBarcode", () => {
  it("returns null for unexpected response payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ nope: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1234567890123");

    expect(result).toBeNull();
  });
});

describe("micronutrient extraction", () => {
  it("extracts micronutrients from per-serving nutriment data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        status: 1,
        product: {
          code: "123",
          product_name: "Fortified Cereal",
          nutriments: {
            "energy-kcal_serving": 200,
            proteins_serving: 5,
            carbohydrates_serving: 40,
            fat_serving: 3,
            fiber_serving: 6,
            "saturated-fat_serving": 1.2,
            "trans-fat_serving": 0,
            sugars_serving: 12,
            sodium_serving: 0.3,
            cholesterol_serving: 0,
            potassium_serving: 200,
            calcium_serving: 130,
            iron_serving: 8.1,
            "vitamin-a_serving": 150,
            "vitamin-c_serving": 60,
            "vitamin-d_serving": 2.5,
            "vitamin-b12_serving": 1.2,
            magnesium_serving: 40,
            zinc_serving: 3.8,
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("123");

    expect(result).not.toBeNull();
    expect(result?.name).toBe("Fortified Cereal");
    expect(result?.calories).toBe(200);
    // Fat breakdown
    expect(result?.nutrients.saturated_fat).toBe(1.2);
    expect(result?.nutrients.trans_fat).toBe(0);
    expect(result?.nutrients.sugar).toBe(12);
    // Sodium is stored in grams in OFF, converted to mg
    expect(result?.nutrients.sodium).toBe(300);
    expect(result?.nutrients.cholesterol).toBe(0);
    expect(result?.nutrients.potassium).toBe(200);
    // Minerals
    expect(result?.nutrients.calcium).toBe(130);
    expect(result?.nutrients.iron).toBe(8.1);
    expect(result?.nutrients.magnesium).toBe(40);
    expect(result?.nutrients.zinc).toBe(3.8);
    // Vitamins
    expect(result?.nutrients.vitamin_a).toBe(150);
    expect(result?.nutrients.vitamin_c).toBe(60);
    expect(result?.nutrients.vitamin_d).toBe(2.5);
    expect(result?.nutrients.vitamin_b12).toBe(1.2);
  });

  it("falls back to per-100g values when per-serving is unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        status: 1,
        product: {
          code: "456",
          product_name: "Plain Yogurt",
          nutriments: {
            "energy-kcal_100g": 60,
            proteins_100g: 3.5,
            carbohydrates_100g: 5,
            fat_100g: 3,
            calcium_100g: 120,
            "vitamin-d_100g": 0.8,
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("456");

    expect(result).not.toBeNull();
    expect(result?.nutrients.calcium).toBe(120);
    expect(result?.nutrients.vitamin_d).toBe(0.8);
  });

  it("returns null for micronutrient fields not present in the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        status: 1,
        product: {
          code: "789",
          product_name: "Simple Bread",
          nutriments: {
            "energy-kcal_100g": 250,
            proteins_100g: 8,
            carbohydrates_100g: 48,
            fat_100g: 3,
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("789");

    expect(result).not.toBeNull();
    // Absent nutrients should not be present in the map
    expect(result?.nutrients.vitamin_a).toBeUndefined();
    expect(result?.nutrients.calcium).toBeUndefined();
    expect(result?.nutrients.iron).toBeUndefined();
    expect(result?.nutrients.omega_3).toBeUndefined();
  });

  it("converts omega-3 and omega-6 from grams to milligrams", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        status: 1,
        product: {
          code: "321",
          product_name: "Salmon Fillet",
          nutriments: {
            "energy-kcal_serving": 350,
            proteins_serving: 40,
            carbohydrates_serving: 0,
            fat_serving: 20,
            "omega-3-fat_serving": 2.5,
            "omega-6-fat_serving": 0.8,
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("321");

    expect(result).not.toBeNull();
    expect(result?.nutrients.omega_3).toBe(2500);
    expect(result?.nutrients.omega_6).toBe(800);
  });

  it("includes micronutrients in search results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          {
            code: "111",
            product_name: "Orange Juice",
            lang: "en",
            nutriments: {
              "energy-kcal_serving": 110,
              proteins_serving: 2,
              carbohydrates_serving: 26,
              fat_serving: 0,
              "vitamin-c_serving": 72,
              potassium_serving: 450,
              calcium_serving: 20,
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const results = await client.searchFoods("orange juice", 5);

    expect(results).toHaveLength(1);
    expect(results[0]?.nutrients.vitamin_c).toBe(72);
    expect(results[0]?.nutrients.potassium).toBe(450);
    expect(results[0]?.nutrients.calcium).toBe(20);
  });
});
