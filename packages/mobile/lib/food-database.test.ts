import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenFoodFactsClient } from "./food-database";

function createFetchResponse(payload: unknown) {
  return {
    ok: true,
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

    // searchFoods fires localized + global searches in parallel
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const localizedUrl = new URL(String(fetchMock.mock.calls[0]?.[0] ?? ""));
    const globalUrl = new URL(String(fetchMock.mock.calls[1]?.[0] ?? ""));

    // Localized call includes country filter
    expect(localizedUrl.searchParams.get("lc")).toBe("en");
    expect(localizedUrl.searchParams.get("countries_tags_en")).toBe("united-states");
    expect(localizedUrl.searchParams.get("search_terms")).toBe("hamburger");
    expect(localizedUrl.searchParams.get("page_size")).toBe("5");

    // Global call omits country filter
    expect(globalUrl.searchParams.get("countries_tags_en")).toBeNull();
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
