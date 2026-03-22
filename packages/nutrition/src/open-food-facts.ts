import { z } from "zod";

const BASE_URL = "https://world.openfoodfacts.org";
const DEFAULT_LOCALE = "en-US";

const countryTagsByRegion: Record<string, string> = {
  AU: "australia",
  CA: "canada",
  GB: "united-kingdom",
  IE: "ireland",
  NZ: "new-zealand",
  US: "united-states",
};

export interface FoodDatabaseResult {
  barcode: string | null;
  name: string;
  brand: string | null;
  servingSize: string | null;
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  imageUrl: string | null;
}

interface SearchLocalePreferences {
  languageCode: string;
  countryTag: string | null;
}

const openFoodFactsProductSchema = z
  .object({
    code: z.string().optional(),
    product_name: z.string().optional(),
    brands: z.string().optional(),
    lang: z.string().optional(),
    serving_size: z.string().optional(),
    nutriments: z.record(z.unknown()).optional(),
    image_front_small_url: z.string().optional(),
  })
  .catchall(z.unknown());

const searchResponseSchema = z.object({
  products: z.array(openFoodFactsProductSchema).default([]),
});

const barcodeResponseSchema = z.object({
  status: z.number(),
  product: openFoodFactsProductSchema.optional(),
});

type OpenFoodFactsProduct = z.infer<typeof openFoodFactsProductSchema>;

function getLocalePreferences(locale?: string): SearchLocalePreferences {
  const fallbackLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  const normalizedLocale = (locale ?? fallbackLocale ?? DEFAULT_LOCALE).replace("_", "-");
  const [languagePart, regionPart] = normalizedLocale.split("-");
  const languageCode = languagePart?.toLowerCase() || "en";
  const regionCode = regionPart?.toUpperCase();
  const countryTag =
    (regionCode ? countryTagsByRegion[regionCode] : null) ??
    (languageCode === "en" ? "united-states" : null);
  return { languageCode, countryTag };
}

export class OpenFoodFactsClient {
  readonly #localePreferences: SearchLocalePreferences;

  constructor(locale?: string) {
    this.#localePreferences = getLocalePreferences(locale);
  }

  async lookupBarcode(barcode: string): Promise<FoodDatabaseResult | null> {
    try {
      const response = await fetch(
        `${BASE_URL}/api/v2/product/${barcode}.json?fields=code,product_name,brands,serving_size,nutriments,image_front_small_url,lang,product_name_${this.#localePreferences.languageCode}`,
      );
      if (!response.ok) return null;

      const data: unknown = await response.json();
      const parsedResponse = barcodeResponseSchema.safeParse(data);
      if (!parsedResponse.success) return null;
      if (parsedResponse.data.status !== 1 || !parsedResponse.data.product) return null;

      return this.#parseProduct(parsedResponse.data.product, false);
    } catch {
      return null;
    }
  }

  async searchFoods(query: string, limit = 20): Promise<FoodDatabaseResult[]> {
    try {
      const localizedResults = await this.#runSearch(query, limit);
      if (localizedResults.length > 0 || !this.#localePreferences.countryTag) {
        return localizedResults;
      }
      // Fallback to global search if country-filtered results are empty.
      return this.#runSearch(query, limit, { ...this.#localePreferences, countryTag: null });
    } catch {
      return [];
    }
  }

  #getLocalizedName(product: OpenFoodFactsProduct, preferredLanguageCode: string): string | null {
    const localizedNameField = `product_name_${preferredLanguageCode}`;
    const localizedName = product[localizedNameField];
    if (typeof localizedName === "string" && localizedName.trim()) {
      return localizedName.trim();
    }
    if (typeof product.product_name === "string" && product.product_name.trim()) {
      return product.product_name.trim();
    }
    return null;
  }

  #languageMatchesPreference(
    productLanguage: string | undefined,
    preferredLanguageCode: string,
  ): boolean {
    if (!productLanguage) return true;
    const normalizedProductLanguage = productLanguage.toLowerCase();
    return (
      normalizedProductLanguage === preferredLanguageCode ||
      normalizedProductLanguage.startsWith(`${preferredLanguageCode}-`)
    );
  }

  #getNumericNutrimentValue(
    nutriments: Record<string, unknown> | undefined,
    fieldName: string,
  ): number | null {
    const value = nutriments?.[fieldName];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  #parseProduct(
    product: OpenFoodFactsProduct,
    enforceLanguageMatch: boolean,
  ): FoodDatabaseResult | null {
    const preferredLanguageCode = this.#localePreferences.languageCode;
    const name = this.#getLocalizedName(product, preferredLanguageCode);
    if (!name) return null;
    if (
      enforceLanguageMatch &&
      !this.#languageMatchesPreference(product.lang, preferredLanguageCode)
    ) {
      return null;
    }

    const nutriments = product.nutriments;
    const calories =
      this.#getNumericNutrimentValue(nutriments, "energy-kcal_serving") ??
      this.#getNumericNutrimentValue(nutriments, "energy-kcal_100g");
    const proteinG =
      this.#getNumericNutrimentValue(nutriments, "proteins_serving") ??
      this.#getNumericNutrimentValue(nutriments, "proteins_100g");
    const carbsG =
      this.#getNumericNutrimentValue(nutriments, "carbohydrates_serving") ??
      this.#getNumericNutrimentValue(nutriments, "carbohydrates_100g");
    const fatG =
      this.#getNumericNutrimentValue(nutriments, "fat_serving") ??
      this.#getNumericNutrimentValue(nutriments, "fat_100g");
    const fiberG =
      this.#getNumericNutrimentValue(nutriments, "fiber_serving") ??
      this.#getNumericNutrimentValue(nutriments, "fiber_100g");

    return {
      barcode: product.code ?? null,
      name,
      brand: product.brands ?? null,
      servingSize: product.serving_size ?? null,
      calories: calories != null ? Math.round(calories) : null,
      proteinG: proteinG != null ? Math.round(proteinG * 10) / 10 : null,
      carbsG: carbsG != null ? Math.round(carbsG * 10) / 10 : null,
      fatG: fatG != null ? Math.round(fatG * 10) / 10 : null,
      fiberG: fiberG != null ? Math.round(fiberG * 10) / 10 : null,
      imageUrl: product.image_front_small_url ?? null,
    };
  }

  async #runSearch(
    query: string,
    limit: number,
    localeOverride?: SearchLocalePreferences,
  ): Promise<FoodDatabaseResult[]> {
    const localePreferences = localeOverride ?? this.#localePreferences;
    const localizedNameField = `product_name_${localePreferences.languageCode}`;
    const fields = [
      "code",
      "product_name",
      "brands",
      "serving_size",
      "nutriments",
      "image_front_small_url",
      "lang",
    ];
    if (localizedNameField !== "product_name") {
      fields.push(localizedNameField);
    }

    const params = new URLSearchParams({
      search_terms: query,
      search_simple: "1",
      action: "process",
      json: "1",
      page_size: String(limit),
      fields: fields.join(","),
      lc: localePreferences.languageCode,
    });
    if (localePreferences.countryTag) {
      params.set("countries_tags_en", localePreferences.countryTag);
    }

    const response = await fetch(`${BASE_URL}/cgi/search.pl?${params}`);
    if (!response.ok) return [];

    const data: unknown = await response.json();
    const parsedResponse = searchResponseSchema.safeParse(data);
    if (!parsedResponse.success) return [];

    return parsedResponse.data.products
      .map((product) => this.#parseProduct(product, true))
      .filter((product): product is FoodDatabaseResult => product !== null);
  }
}
