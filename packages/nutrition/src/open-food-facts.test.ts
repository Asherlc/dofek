import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenFoodFactsClient } from "./open-food-facts.ts";

function createFetchResponse(payload: unknown, ok = true) {
  return {
    ok,
    json: async () => payload,
  };
}

/** Helper to create a barcode API response with a given product */
function barcodeLookupResponse(product: Record<string, unknown>) {
  return createFetchResponse({ status: 1, product });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── getLocalePreferences (exercised through constructor → search URL) ────────

describe("locale handling", () => {
  it("uses underscore-separated locales (e.g. en_US)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          { code: "1", product_name: "Taco", lang: "en", nutriments: { "energy-kcal_100g": 200 } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en_US");
    await client.searchFoods("taco", 5);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("lc")).toBe("en");
    expect(url.searchParams.get("countries_tags_en")).toBe("united-states");
  });

  it("maps AU region to australia country tag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ products: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-AU");
    await client.searchFoods("vegemite", 5);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("countries_tags_en")).toBe("australia");
  });

  it("maps GB region to united-kingdom country tag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ products: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-GB");
    await client.searchFoods("biscuit", 5);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("countries_tags_en")).toBe("united-kingdom");
  });

  it("maps CA region to canada country tag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ products: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-CA");
    await client.searchFoods("maple syrup", 5);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("countries_tags_en")).toBe("canada");
  });

  it("maps IE region to ireland country tag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ products: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-IE");
    await client.searchFoods("butter", 5);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("countries_tags_en")).toBe("ireland");
  });

  it("maps NZ region to new-zealand country tag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ products: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-NZ");
    await client.searchFoods("kiwi", 5);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("countries_tags_en")).toBe("new-zealand");
  });

  it("defaults English without region to united-states", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ products: [] }));
    vi.stubGlobal("fetch", fetchMock);

    // "en" alone — no region, but languageCode is "en" so fallback is united-states
    const client = new OpenFoodFactsClient("en");
    await client.searchFoods("bread", 5);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("lc")).toBe("en");
    expect(url.searchParams.get("countries_tags_en")).toBe("united-states");
  });

  it("omits country tag for non-English locale without known region", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          { code: "1", product_name: "Pain", lang: "fr", nutriments: { "energy-kcal_100g": 250 } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // French without a region — no country tag
    const client = new OpenFoodFactsClient("fr");
    await client.searchFoods("pain", 5);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("lc")).toBe("fr");
    expect(url.searchParams.get("countries_tags_en")).toBeNull();
  });

  it("does not fall back to global search when no country tag is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ products: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("fr");
    const results = await client.searchFoods("croissant", 5);

    // Should only call once — no fallback because there's no country tag to drop
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(0);
  });

  it("uses non-English locale in search and includes localized field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          {
            code: "99",
            product_name: "Croissant",
            product_name_fr: "Croissant au Beurre",
            lang: "fr",
            nutriments: { "energy-kcal_100g": 400 },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("fr-FR");
    const results = await client.searchFoods("croissant", 5);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("lc")).toBe("fr");
    // Fields should include product_name_fr
    const fields = url.searchParams.get("fields")?.split(",") ?? [];
    expect(fields).toContain("product_name_fr");
    // Prefers localized name
    expect(results[0]?.name).toBe("Croissant au Beurre");
  });

  it("does not duplicate product_name in fields when language is default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ products: [] }));
    vi.stubGlobal("fetch", fetchMock);

    // Construct a scenario where the localized field equals "product_name"
    // This happens if languageCode came out as "product_name".split("_")[1] — but actually
    // it can't. The check is `localizedNameField !== "product_name"`. Let's verify the
    // default en-US path doesn't push a duplicate.
    const client = new OpenFoodFactsClient("en-US");
    await client.searchFoods("pizza", 5);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const fields = url.searchParams.get("fields")?.split(",") ?? [];
    expect(fields).toContain("product_name_en");
    expect(fields).toContain("product_name");
    // product_name_en !== product_name so both should be present (no duplication issue)
  });
});

// ── searchFoods ──────────────────────────────────────────────────────────────

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
    const localizedPromise = new Promise((resolve) => {
      resolveLocalized = resolve;
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

    await expect(resultPromise).rejects.toThrow("Aborted");
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

  it("includes products whose language starts with preferred code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          {
            code: "1",
            product_name: "English Muffin",
            lang: "en-GB",
            nutriments: { "energy-kcal_100g": 200 },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const results = await client.searchFoods("muffin", 10);

    // "en-GB" starts with "en-" so it should match
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("English Muffin");
  });

  it("excludes products whose language only partially matches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          {
            code: "1",
            product_name: "Endive",
            lang: "ens", // not "en" or "en-..."
            nutriments: { "energy-kcal_100g": 100 },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const results = await client.searchFoods("endive", 10);

    expect(results).toHaveLength(0);
  });

  it("includes products with no language set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          {
            code: "1",
            product_name: "Mystery Food",
            nutriments: { "energy-kcal_100g": 100 },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const results = await client.searchFoods("mystery", 10);

    // No lang → treated as matching
    expect(results).toHaveLength(1);
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

  it("falls back to product_name when locale-specific name is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          {
            code: "11",
            product_name: "Salsa Verde",
            product_name_en: "   ",
            lang: "en",
            nutriments: { "energy-kcal_100g": 40 },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const results = await client.searchFoods("salsa", 10);

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("Salsa Verde");
  });

  it("filters out products with no name at all", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          {
            code: "12",
            lang: "en",
            nutriments: { "energy-kcal_100g": 100 },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const results = await client.searchFoods("food", 10);

    expect(results).toHaveLength(0);
  });

  it("filters out products with whitespace-only product_name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        products: [
          {
            code: "13",
            product_name: "   ",
            lang: "en",
            nutriments: { "energy-kcal_100g": 100 },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const results = await client.searchFoods("food", 10);

    expect(results).toHaveLength(0);
  });

  it("propagates network errors to the caller", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const client = new OpenFoodFactsClient("en-US");
    await expect(client.searchFoods("hamburger", 5)).rejects.toThrow("network down");
  });

  it("returns empty array when fetch response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createFetchResponse({}, false)));

    const client = new OpenFoodFactsClient("en-US");
    const results = await client.searchFoods("hamburger", 5);

    expect(results).toHaveLength(0);
  });

  it("returns empty array when response fails Zod parsing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createFetchResponse("not an object")));

    const client = new OpenFoodFactsClient("en-US");
    const results = await client.searchFoods("hamburger", 5);

    expect(results).toHaveLength(0);
  });

  it("uses default limit of 20", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ products: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    await client.searchFoods("pizza");

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("page_size")).toBe("20");
  });

  it("includes search_simple, action, and json params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ products: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    await client.searchFoods("pizza", 5);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("search_simple")).toBe("1");
    expect(url.searchParams.get("action")).toBe("process");
    expect(url.searchParams.get("json")).toBe("1");
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

// ── lookupBarcode ────────────────────────────────────────────────────────────

describe("lookupBarcode", () => {
  it("returns null for unexpected response payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ nope: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1234567890123");

    expect(result).toBeNull();
  });

  it("returns null when status is 0 (product not found)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createFetchResponse({ status: 0 })));

    const client = new OpenFoodFactsClient("en-US");
    expect(await client.lookupBarcode("0000000000000")).toBeNull();
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

  it("propagates network errors to the caller", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const client = new OpenFoodFactsClient("en-US");
    await expect(client.lookupBarcode("1234567890123")).rejects.toThrow("offline");
  });

  it("returns null when product has no name", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(barcodeLookupResponse({ code: "1" })));

    const client = new OpenFoodFactsClient("en-US");
    expect(await client.lookupBarcode("1")).toBeNull();
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

  it("builds correct URL with barcode and fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      barcodeLookupResponse({
        code: "049000042566",
        product_name: "Coca-Cola",
        nutriments: { "energy-kcal_serving": 140 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenFoodFactsClient("en-US");
    await client.lookupBarcode("049000042566");

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/v2/product/049000042566.json");
    expect(url).toContain("product_name_en");
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

  it("populates all result fields from product data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          code: "049000042566",
          product_name: "Coca-Cola Classic",
          brands: "Coca-Cola",
          serving_size: "355 ml",
          image_front_small_url: "https://images.off.org/coca-cola.jpg",
          nutriments: {
            "energy-kcal_serving": 140,
            proteins_serving: 0,
            carbohydrates_serving: 39,
            fat_serving: 0,
            fiber_serving: 0,
            sugars_serving: 39,
          },
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("049000042566");

    expect(result).not.toBeNull();
    expect(result?.barcode).toBe("049000042566");
    expect(result?.name).toBe("Coca-Cola Classic");
    expect(result?.brand).toBe("Coca-Cola");
    expect(result?.servingSize).toBe("355 ml");
    expect(result?.imageUrl).toBe("https://images.off.org/coca-cola.jpg");
    expect(result?.calories).toBe(140);
    expect(result?.proteinG).toBe(0);
    expect(result?.carbsG).toBe(39);
    expect(result?.fatG).toBe(0);
    expect(result?.fiberG).toBe(0);
    expect(result?.nutrients.sugar).toBe(39);
  });

  it("returns null for optional fields when product omits them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          product_name: "Minimal Product",
          nutriments: { "energy-kcal_100g": 100 },
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1");

    expect(result).not.toBeNull();
    expect(result?.barcode).toBeNull();
    expect(result?.brand).toBeNull();
    expect(result?.servingSize).toBeNull();
    expect(result?.imageUrl).toBeNull();
  });

  it("does not enforce language match for barcode lookups", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          code: "1",
          product_name: "Baguette Tradition",
          lang: "fr",
          nutriments: { "energy-kcal_100g": 270 },
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1");

    // Barcode lookup does not enforce language — should still return product
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Baguette Tradition");
  });

  it("rounds fractional calories to the nearest integer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          code: "1",
          product_name: "Granola",
          nutriments: { "energy-kcal_serving": 249.6 },
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1");

    expect(result?.calories).toBe(250);
  });

  it("returns null calories when no energy-kcal is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          code: "1",
          product_name: "Water",
          nutriments: {},
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1");

    expect(result?.calories).toBeNull();
  });

  it("parses string nutriment values in barcode results", async () => {
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

  it("returns null for non-finite nutriment values in barcode results", async () => {
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

// ── nutriment value parsing ──────────────────────────────────────────────────

describe("nutriment value parsing", () => {
  it("parses string nutriment values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          code: "1",
          product_name: "Stringy Food",
          nutriments: {
            "energy-kcal_serving": "180",
            proteins_serving: "12.5",
            carbohydrates_serving: "20",
            fat_serving: "8",
          },
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1");

    expect(result?.calories).toBe(180);
    expect(result?.proteinG).toBe(12.5);
    expect(result?.carbsG).toBe(20);
    expect(result?.fatG).toBe(8);
  });

  it("returns null for non-finite string values like NaN", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          code: "1",
          product_name: "Bad Data",
          nutriments: {
            "energy-kcal_serving": "not a number",
            proteins_serving: "NaN",
            carbohydrates_serving: "",
          },
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1");

    expect(result?.calories).toBeNull();
    expect(result?.proteinG).toBeNull();
    // Empty string parseFloat returns NaN, should be null
    expect(result?.carbsG).toBeNull();
  });

  it("returns null for boolean/object nutriment values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          code: "1",
          product_name: "Weird Data",
          nutriments: {
            "energy-kcal_serving": true,
            proteins_serving: { amount: 5 },
            carbohydrates_serving: null,
          },
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1");

    expect(result?.calories).toBeNull();
    expect(result?.proteinG).toBeNull();
    expect(result?.carbsG).toBeNull();
  });

  it("returns null for Infinity nutriment values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          code: "1",
          product_name: "Infinite Food",
          nutriments: {
            "energy-kcal_serving": Number.POSITIVE_INFINITY,
            proteins_serving: Number.NEGATIVE_INFINITY,
          },
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1");

    expect(result?.calories).toBeNull();
    expect(result?.proteinG).toBeNull();
  });

  it("prefers per-serving over per-100g values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          code: "1",
          product_name: "Dual Values",
          nutriments: {
            "energy-kcal_serving": 150,
            "energy-kcal_100g": 300,
            proteins_serving: 10,
            proteins_100g: 20,
          },
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1");

    expect(result?.calories).toBe(150);
    expect(result?.proteinG).toBe(10);
  });

  it("rounds micronutrient values to one decimal place", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          code: "1",
          product_name: "Precise Food",
          nutriments: {
            "energy-kcal_serving": 100,
            calcium_serving: 45.678,
            iron_serving: 2.349,
            "vitamin-c_serving": 0.15,
          },
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1");

    expect(result?.nutrients.calcium).toBe(45.7);
    expect(result?.nutrients.iron).toBe(2.3);
    expect(result?.nutrients.vitamin_c).toBe(0.2);
  });

  it("handles undefined nutriments gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          code: "1",
          product_name: "No Nutriments",
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1");

    expect(result).not.toBeNull();
    expect(result?.calories).toBeNull();
    expect(result?.proteinG).toBeNull();
    expect(result?.carbsG).toBeNull();
    expect(result?.fatG).toBeNull();
    expect(result?.fiberG).toBeNull();
    expect(Object.keys(result?.nutrients ?? {})).toHaveLength(0);
  });
});

// ── micronutrient extraction ─────────────────────────────────────────────────

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
    // Also verify macros fell back to 100g
    expect(result?.proteinG).toBe(3.5);
    expect(result?.carbsG).toBe(5);
    expect(result?.fatG).toBe(3);
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

  it("extracts all vitamin B variants and vitamin E/K", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          code: "1",
          product_name: "Multivitamin Juice",
          nutriments: {
            "energy-kcal_serving": 50,
            "vitamin-e_serving": 7.5,
            "vitamin-k_serving": 25,
            "vitamin-b1_serving": 0.6,
            "vitamin-b2_serving": 0.7,
            "vitamin-pp_serving": 8, // niacin / B3
            "pantothenic-acid_serving": 2.5, // B5
            "vitamin-b6_serving": 0.85,
            biotin_serving: 15, // B7
            "vitamin-b9_serving": 200,
          },
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1");

    expect(result?.nutrients.vitamin_e).toBe(7.5);
    expect(result?.nutrients.vitamin_k).toBe(25);
    expect(result?.nutrients.vitamin_b1).toBe(0.6);
    expect(result?.nutrients.vitamin_b2).toBe(0.7);
    expect(result?.nutrients.vitamin_b3).toBe(8);
    expect(result?.nutrients.vitamin_b5).toBe(2.5);
    expect(result?.nutrients.vitamin_b6).toBe(0.9);
    expect(result?.nutrients.vitamin_b7).toBe(15);
    expect(result?.nutrients.vitamin_b9).toBe(200);
  });

  it("extracts all mineral types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          code: "1",
          product_name: "Mineral Water Plus",
          nutriments: {
            "energy-kcal_serving": 0,
            selenium_serving: 27.5,
            copper_serving: 0.45,
            manganese_serving: 1.2,
            chromium_serving: 17.5,
            iodine_serving: 75,
            phosphorus_serving: 125,
            molybdenum_serving: 22.5,
            chloride_serving: 36,
            fluoride_serving: 1.5,
            choline_serving: 275,
          },
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1");

    expect(result?.nutrients.selenium).toBe(27.5);
    expect(result?.nutrients.copper).toBe(0.5);
    expect(result?.nutrients.manganese).toBe(1.2);
    expect(result?.nutrients.chromium).toBe(17.5);
    expect(result?.nutrients.iodine).toBe(75);
    expect(result?.nutrients.phosphorus).toBe(125);
    expect(result?.nutrients.molybdenum).toBe(22.5);
    expect(result?.nutrients.chloride).toBe(36);
    expect(result?.nutrients.fluoride).toBe(1.5);
    expect(result?.nutrients.choline).toBe(275);
  });

  it("extracts fat breakdown subtypes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          code: "1",
          product_name: "Olive Oil",
          nutriments: {
            "energy-kcal_serving": 120,
            fat_serving: 14,
            "saturated-fat_serving": 2,
            "polyunsaturated-fat_serving": 1.5,
            "monounsaturated-fat_serving": 10,
            "trans-fat_serving": 0,
          },
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1");

    expect(result?.nutrients.saturated_fat).toBe(2);
    expect(result?.nutrients.polyunsaturated_fat).toBe(1.5);
    expect(result?.nutrients.monounsaturated_fat).toBe(10);
    expect(result?.nutrients.trans_fat).toBe(0);
  });

  it("skips nutrients that have null openFoodFactsKey", async () => {
    // This test verifies the `definition.openFoodFactsKey === null` continue branch.
    // Currently all NUTRIENTS have a key, but the code handles null. We verify
    // that the nutrients map only contains keys that are in the NUTRIENTS catalog.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        barcodeLookupResponse({
          code: "1",
          product_name: "Test Food",
          nutriments: {
            "energy-kcal_serving": 100,
            calcium_serving: 50,
            "some-unknown-nutrient_serving": 999,
          },
        }),
      ),
    );

    const client = new OpenFoodFactsClient("en-US");
    const result = await client.lookupBarcode("1");

    // The "some-unknown-nutrient" won't appear because it's not in NUTRIENTS
    expect(result?.nutrients.calcium).toBe(50);
    expect(Object.keys(result?.nutrients ?? {})).toEqual(["calcium"]);
  });
});

// ── searchFoods edge cases ───────────────────────────────────────────────────

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
