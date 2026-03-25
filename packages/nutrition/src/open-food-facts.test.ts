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

    // The localized search (with country filter) should be one of the calls
    const localizedCall = fetchMock.mock.calls.find((call) => {
      const url = new URL(String(call[0]));
      return url.searchParams.get("countries_tags_en") !== null;
    });
    expect(localizedCall).toBeDefined();
    const parsedUrl = new URL(String(localizedCall?.[0]));

    expect(parsedUrl.searchParams.get("lc")).toBe("en");
    expect(parsedUrl.searchParams.get("countries_tags_en")).toBe("united-states");
    expect(parsedUrl.searchParams.get("search_terms")).toBe("hamburger");
    expect(parsedUrl.searchParams.get("page_size")).toBe("5");
  });

  it("falls back to global search when country-filtered results are empty", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const parsedUrl = new URL(url);
      const isLocalized = parsedUrl.searchParams.get("countries_tags_en") !== null;

      if (isLocalized) {
        return Promise.resolve(createFetchResponse({ products: [] }));
      }
      return Promise.resolve(
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
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const results = await client.searchFoods("hamburger", 5);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const localizedCall = fetchMock.mock.calls.find((call) => {
      const url = new URL(String(call[0]));
      return url.searchParams.get("countries_tags_en") !== null;
    });
    const globalCall = fetchMock.mock.calls.find((call) => {
      const url = new URL(String(call[0]));
      return url.searchParams.get("countries_tags_en") === null;
    });
    expect(localizedCall).toBeDefined();
    expect(globalCall).toBeDefined();
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("Hamburger Bun");
  });

  it("runs localized and global searches in parallel", async () => {
    // Use a manually-controlled promise so the localized search stays pending
    let resolveLocalized!: (value: unknown) => void;
    const localizedPromise = new Promise((r) => {
      resolveLocalized = r;
    });

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const parsedUrl = new URL(url);
      const isLocalized = parsedUrl.searchParams.get("countries_tags_en") !== null;

      if (isLocalized) {
        // Return a pending promise — doesn't resolve until we say so
        return localizedPromise;
      }
      return Promise.resolve(
        createFetchResponse({
          products: [
            {
              code: "7",
              product_name: "Global Burger",
              lang: "en",
              nutriments: { "energy-kcal_100g": 240 },
            },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const resultPromise = client.searchFoods("hamburger", 5);

    // In parallel code, both fetches are called immediately (before the localized one resolves).
    // In sequential code, only the localized fetch would be called at this point.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Now let the localized search resolve with no results
    resolveLocalized(createFetchResponse({ products: [] }));
    const results = await resultPromise;

    // Should use global fallback results
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("Global Burger");
  });

  it("prefers localized results over global when both return data", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const parsedUrl = new URL(url);
      const isLocalized = parsedUrl.searchParams.get("countries_tags_en") !== null;

      return Promise.resolve(
        createFetchResponse({
          products: isLocalized
            ? [
                {
                  code: "1",
                  product_name: "US Burger",
                  lang: "en",
                  nutriments: { "energy-kcal_100g": 250 },
                },
              ]
            : [
                {
                  code: "2",
                  product_name: "Global Burger",
                  lang: "en",
                  nutriments: { "energy-kcal_100g": 260 },
                },
              ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const results = await client.searchFoods("burger", 5);

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("US Burger");
  });

  it("passes abort signal to fetch requests", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const client = new OpenFoodFactsClient("en-US");
    const resultPromise = client.searchFoods("burger", 5, controller.signal);
    controller.abort();

    const results = await resultPromise;
    expect(results).toEqual([]);
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

describe("searchFoods", () => {
  it("skips parallel global search when locale has no country tag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          {
            code: "1",
            product_name: "Burger",
            lang: "zh",
            nutriments: { "energy-kcal_100g": 250 },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // "zh" has no country mapping, so countryTag is null — only one fetch should fire
    const client = new OpenFoodFactsClient("zh");
    const results = await client.searchFoods("burger", 5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("countries_tags_en")).toBeNull();
    expect(results).toHaveLength(1);
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

  it("returns null when HTTP response is not ok", async () => {
    // Return valid-looking product data with ok:false so the only guard is response.ok
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse(
        {
          status: 1,
          product: {
            code: "123",
            product_name: "Ghost Product",
            lang: "en",
            nutriments: { "energy-kcal_100g": 100 },
          },
        },
        false,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1234567890123");

    expect(result).toBeNull();
  });

  it("returns product data for a valid barcode response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        status: 1,
        product: {
          code: "3017620422003",
          product_name: "Nutella",
          brands: "Ferrero",
          lang: "en",
          serving_size: "15g",
          nutriments: {
            "energy-kcal_serving": 80,
            proteins_serving: 0.9,
            carbohydrates_serving: 8.6,
            fat_serving: 4.7,
            fiber_serving: 0.5,
          },
          image_front_small_url: "https://example.com/nutella.jpg",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("3017620422003");

    expect(result).not.toBeNull();
    expect(result?.barcode).toBe("3017620422003");
    expect(result?.name).toBe("Nutella");
    expect(result?.brand).toBe("Ferrero");
    expect(result?.servingSize).toBe("15g");
    expect(result?.calories).toBe(80);
    expect(result?.proteinG).toBe(0.9);
    expect(result?.carbsG).toBe(8.6);
    expect(result?.fatG).toBe(4.7);
    expect(result?.fiberG).toBe(0.5);
    expect(result?.imageUrl).toBe("https://example.com/nutella.jpg");
  });

  it("returns null when product status is not 1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        status: 0,
        product: {
          code: "000",
          product_name: "Not Found",
          lang: "en",
          nutriments: {},
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("000");
    expect(result).toBeNull();
  });

  it("returns null when product field is missing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ status: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("000");
    expect(result).toBeNull();
  });

  it("skips products with empty or whitespace-only names", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        status: 1,
        product: {
          code: "111",
          product_name: "   ",
          lang: "en",
          nutriments: {},
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("111");
    expect(result).toBeNull();
  });

  it("parses string nutriment values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        status: 1,
        product: {
          code: "222",
          product_name: "Cheese",
          lang: "en",
          nutriments: {
            "energy-kcal_100g": "350",
            proteins_100g: "25.5",
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("222");
    expect(result).not.toBeNull();
    expect(result?.calories).toBe(350);
    expect(result?.proteinG).toBe(25.5);
  });

  it("returns null for non-finite nutriment values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        status: 1,
        product: {
          code: "333",
          product_name: "Mystery",
          lang: "en",
          nutriments: {
            "energy-kcal_100g": "not-a-number",
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("333");
    expect(result).not.toBeNull();
    expect(result?.calories).toBeNull();
  });
});

describe("searchFoods edge cases", () => {
  it("returns empty array when search HTTP response is not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({}, false));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("zh");
    const results = await client.searchFoods("burger", 5);
    expect(results).toEqual([]);
  });

  it("returns empty array when search response shape is invalid", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse("not json object"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("zh");
    const results = await client.searchFoods("burger", 5);
    expect(results).toEqual([]);
  });

  it("filters out products with no name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          { code: "1", lang: "zh", nutriments: {} },
          { code: "2", product_name: "Valid", lang: "zh", nutriments: {} },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("zh");
    const results = await client.searchFoods("test", 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("Valid");
  });

  it("trims whitespace from product names", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          {
            code: "1",
            product_name: "  Trimmed Name  ",
            lang: "zh",
            nutriments: {},
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("zh");
    const results = await client.searchFoods("test", 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("Trimmed Name");
  });

  it("includes products with no lang field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          {
            code: "1",
            product_name: "No Lang Product",
            nutriments: {},
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const results = await client.searchFoods("test", 10);
    expect(results).toHaveLength(1);
  });

  it("uses Australian country tag for en-AU locale", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ products: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-AU");
    await client.searchFoods("vegemite", 5);

    const localizedCall = fetchMock.mock.calls.find((call) => {
      const url = new URL(String(call[0]));
      return url.searchParams.get("countries_tags_en") === "australia";
    });
    expect(localizedCall).toBeDefined();
  });

  it("defaults to united-states for plain English locale", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ products: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en");
    await client.searchFoods("burger", 5);

    const localizedCall = fetchMock.mock.calls.find((call) => {
      const url = new URL(String(call[0]));
      return url.searchParams.get("countries_tags_en") === "united-states";
    });
    expect(localizedCall).toBeDefined();
  });
});
