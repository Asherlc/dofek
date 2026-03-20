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

describe("lookupBarcode", () => {
  it("returns null for unexpected response payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ nope: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1234567890123");

    expect(result).toBeNull();
  });
});
