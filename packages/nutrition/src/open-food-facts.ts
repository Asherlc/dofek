import { z } from "zod";
import { NUTRIENTS } from "./nutrients.ts";

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
  imageUrl: string | null;
  // Macronutrients (stay as top-level fields — queried on every endpoint)
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  /** Micronutrients keyed by nutrient id (e.g. 'vitamin_a' → 150). Only present nutrients are included. */
  nutrients: Record<string, number>;
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

  /** Get a nutriment value, preferring per-serving over per-100g, with optional unit conversion. */
  #getNutrimentWithConversion(
    nutriments: Record<string, unknown> | undefined,
    offKey: string,
    conversionFactor = 1,
  ): number | null {
    const raw =
      this.#getNumericNutrimentValue(nutriments, `${offKey}_serving`) ??
      this.#getNumericNutrimentValue(nutriments, `${offKey}_100g`);
    if (raw == null) return null;
    const converted = raw * conversionFactor;
    return Math.round(converted * 10) / 10;
  }

  async lookupBarcode(barcode: string, signal?: AbortSignal): Promise<FoodDatabaseResult | null> {
    const response = await fetch(
      `${BASE_URL}/api/v2/product/${barcode}.json?fields=code,product_name,brands,serving_size,nutriments,image_front_small_url,lang,product_name_${this.#localePreferences.languageCode}`,
      { signal },
    );
    if (!response.ok) return null;

    const data: unknown = await response.json();
    const parsedResponse = barcodeResponseSchema.safeParse(data);
    if (!parsedResponse.success) return null;
    if (parsedResponse.data.status !== 1 || !parsedResponse.data.product) return null;

    return this.#parseProduct(parsedResponse.data.product, false);
  }

  async searchFoods(
    query: string,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<FoodDatabaseResult[]> {
    if (!this.#localePreferences.countryTag) {
      return this.#runSearch(query, limit, undefined, signal);
    }

    // Run localized and global searches in parallel to avoid sequential latency.
    const [localizedResults, globalResults] = await Promise.all([
      this.#runSearch(query, limit, undefined, signal),
      this.#runSearch(query, limit, { ...this.#localePreferences, countryTag: null }, signal),
    ]);

    // Prefer localized results; fall back to global if empty.
    return localizedResults.length > 0 ? localizedResults : globalResults;
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

    // Build micronutrients map from the canonical catalog
    const nutrients: Record<string, number> = {};
    for (const definition of NUTRIENTS) {
      if (definition.openFoodFactsKey === null) continue;
      const value = this.#getNutrimentWithConversion(
        nutriments,
        definition.openFoodFactsKey,
        definition.conversionFactor,
      );
      if (value !== null) {
        nutrients[definition.id] = value;
      }
    }

    return {
      barcode: product.code ?? null,
      name,
      brand: product.brands ?? null,
      servingSize: product.serving_size ?? null,
      calories: calories != null ? Math.round(calories) : null,
      imageUrl: product.image_front_small_url ?? null,
      proteinG: this.#getNutrimentWithConversion(nutriments, "proteins"),
      carbsG: this.#getNutrimentWithConversion(nutriments, "carbohydrates"),
      fatG: this.#getNutrimentWithConversion(nutriments, "fat"),
      fiberG: this.#getNutrimentWithConversion(nutriments, "fiber"),
      nutrients,
    };
  }

  async #runSearch(
    query: string,
    limit: number,
    localeOverride?: SearchLocalePreferences,
    signal?: AbortSignal,
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

    const response = await fetch(`${BASE_URL}/cgi/search.pl?${params}`, { signal });
    if (!response.ok) return [];

    const data: unknown = await response.json();
    const parsedResponse = searchResponseSchema.safeParse(data);
    if (!parsedResponse.success) return [];

    return parsedResponse.data.products
      .map((product) => this.#parseProduct(product, true))
      .filter((product): product is FoodDatabaseResult => product !== null);
  }
}
