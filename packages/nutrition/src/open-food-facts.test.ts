import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupBarcode, searchFoods } from "./open-food-facts.ts";

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

    await searchFoods("hamburger", 5, "en-US");

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

    await searchFoods("hamburger", 5, "en-US");

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

    const results = await searchFoods("hamburger", 10, "en-US");

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

    const results = await searchFoods("burger", 10, "en-US");

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("Seeded Burger Buns");
  });
});

describe("lookupBarcode", () => {
  it("returns null for unexpected response payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ nope: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookupBarcode("1234567890123", "en-US");

    expect(result).toBeNull();
  });
});
