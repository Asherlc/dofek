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
  // Fat breakdown
  saturatedFatG: number | null;
  polyunsaturatedFatG: number | null;
  monounsaturatedFatG: number | null;
  transFatG: number | null;
  // Other macros
  cholesterolMg: number | null;
  sodiumMg: number | null;
  potassiumMg: number | null;
  sugarG: number | null;
  // Vitamins
  vitaminAMcg: number | null;
  vitaminCMg: number | null;
  vitaminDMcg: number | null;
  vitaminEMg: number | null;
  vitaminKMcg: number | null;
  vitaminB1Mg: number | null;
  vitaminB2Mg: number | null;
  vitaminB3Mg: number | null;
  vitaminB5Mg: number | null;
  vitaminB6Mg: number | null;
  vitaminB7Mcg: number | null;
  vitaminB9Mcg: number | null;
  vitaminB12Mcg: number | null;
  // Minerals
  calciumMg: number | null;
  ironMg: number | null;
  magnesiumMg: number | null;
  zincMg: number | null;
  seleniumMcg: number | null;
  copperMg: number | null;
  manganeseMg: number | null;
  chromiumMcg: number | null;
  iodineMcg: number | null;
  // Fatty acids
  omega3Mg: number | null;
  omega6Mg: number | null;
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
  private readonly localePreferences: SearchLocalePreferences;

  constructor(locale?: string) {
    this.localePreferences = getLocalePreferences(locale);
  }

  /** Get a nutriment value, preferring per-serving over per-100g, with optional unit conversion. */
  private getNutrimentWithConversion(
    nutriments: Record<string, unknown> | undefined,
    offKey: string,
    conversionFactor = 1,
  ): number | null {
    const raw =
      this.getNumericNutrimentValue(nutriments, `${offKey}_serving`) ??
      this.getNumericNutrimentValue(nutriments, `${offKey}_100g`);
    if (raw == null) return null;
    const converted = raw * conversionFactor;
    return Math.round(converted * 10) / 10;
  }

  async lookupBarcode(barcode: string): Promise<FoodDatabaseResult | null> {
    try {
      const response = await fetch(
        `${BASE_URL}/api/v2/product/${barcode}.json?fields=code,product_name,brands,serving_size,nutriments,image_front_small_url,lang,product_name_${this.localePreferences.languageCode}`,
      );
      if (!response.ok) return null;

      const data: unknown = await response.json();
      const parsedResponse = barcodeResponseSchema.safeParse(data);
      if (!parsedResponse.success) return null;
      if (parsedResponse.data.status !== 1 || !parsedResponse.data.product) return null;

      return this.parseProduct(parsedResponse.data.product, false);
    } catch {
      return null;
    }
  }

  async searchFoods(query: string, limit = 20): Promise<FoodDatabaseResult[]> {
    try {
      const localizedResults = await this.runSearch(query, limit);
      if (localizedResults.length > 0 || !this.localePreferences.countryTag) {
        return localizedResults;
      }
      // Fallback to global search if country-filtered results are empty.
      return this.runSearch(query, limit, { ...this.localePreferences, countryTag: null });
    } catch {
      return [];
    }
  }

  private getLocalizedName(
    product: OpenFoodFactsProduct,
    preferredLanguageCode: string,
  ): string | null {
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

  private languageMatchesPreference(
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

  private getNumericNutrimentValue(
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

  private parseProduct(
    product: OpenFoodFactsProduct,
    enforceLanguageMatch: boolean,
  ): FoodDatabaseResult | null {
    const preferredLanguageCode = this.localePreferences.languageCode;
    const name = this.getLocalizedName(product, preferredLanguageCode);
    if (!name) return null;
    if (
      enforceLanguageMatch &&
      !this.languageMatchesPreference(product.lang, preferredLanguageCode)
    ) {
      return null;
    }

    const nutriments = product.nutriments;
    const calories =
      this.getNumericNutrimentValue(nutriments, "energy-kcal_serving") ??
      this.getNumericNutrimentValue(nutriments, "energy-kcal_100g");

    return {
      barcode: product.code ?? null,
      name,
      brand: product.brands ?? null,
      servingSize: product.serving_size ?? null,
      calories: calories != null ? Math.round(calories) : null,
      imageUrl: product.image_front_small_url ?? null,
      // Macronutrients
      proteinG: this.getNutrimentWithConversion(nutriments, "proteins"),
      carbsG: this.getNutrimentWithConversion(nutriments, "carbohydrates"),
      fatG: this.getNutrimentWithConversion(nutriments, "fat"),
      fiberG: this.getNutrimentWithConversion(nutriments, "fiber"),
      // Fat breakdown
      saturatedFatG: this.getNutrimentWithConversion(nutriments, "saturated-fat"),
      polyunsaturatedFatG: this.getNutrimentWithConversion(nutriments, "polyunsaturated-fat"),
      monounsaturatedFatG: this.getNutrimentWithConversion(nutriments, "monounsaturated-fat"),
      transFatG: this.getNutrimentWithConversion(nutriments, "trans-fat"),
      // Other macros
      cholesterolMg: this.getNutrimentWithConversion(nutriments, "cholesterol"),
      sodiumMg: this.getNutrimentWithConversion(nutriments, "sodium", 1000), // OFF stores sodium in grams
      potassiumMg: this.getNutrimentWithConversion(nutriments, "potassium"),
      sugarG: this.getNutrimentWithConversion(nutriments, "sugars"),
      // Vitamins
      vitaminAMcg: this.getNutrimentWithConversion(nutriments, "vitamin-a"),
      vitaminCMg: this.getNutrimentWithConversion(nutriments, "vitamin-c"),
      vitaminDMcg: this.getNutrimentWithConversion(nutriments, "vitamin-d"),
      vitaminEMg: this.getNutrimentWithConversion(nutriments, "vitamin-e"),
      vitaminKMcg: this.getNutrimentWithConversion(nutriments, "vitamin-k"),
      vitaminB1Mg: this.getNutrimentWithConversion(nutriments, "vitamin-b1"),
      vitaminB2Mg: this.getNutrimentWithConversion(nutriments, "vitamin-b2"),
      vitaminB3Mg: this.getNutrimentWithConversion(nutriments, "vitamin-pp"), // OFF uses "vitamin-pp" for niacin/B3
      vitaminB5Mg: this.getNutrimentWithConversion(nutriments, "pantothenic-acid"),
      vitaminB6Mg: this.getNutrimentWithConversion(nutriments, "vitamin-b6"),
      vitaminB7Mcg: this.getNutrimentWithConversion(nutriments, "biotin"),
      vitaminB9Mcg: this.getNutrimentWithConversion(nutriments, "vitamin-b9"),
      vitaminB12Mcg: this.getNutrimentWithConversion(nutriments, "vitamin-b12"),
      // Minerals
      calciumMg: this.getNutrimentWithConversion(nutriments, "calcium"),
      ironMg: this.getNutrimentWithConversion(nutriments, "iron"),
      magnesiumMg: this.getNutrimentWithConversion(nutriments, "magnesium"),
      zincMg: this.getNutrimentWithConversion(nutriments, "zinc"),
      seleniumMcg: this.getNutrimentWithConversion(nutriments, "selenium"),
      copperMg: this.getNutrimentWithConversion(nutriments, "copper"),
      manganeseMg: this.getNutrimentWithConversion(nutriments, "manganese"),
      chromiumMcg: this.getNutrimentWithConversion(nutriments, "chromium"),
      iodineMcg: this.getNutrimentWithConversion(nutriments, "iodine"),
      // Fatty acids (OFF stores in grams, DB stores in mg)
      omega3Mg: this.getNutrimentWithConversion(nutriments, "omega-3-fat", 1000),
      omega6Mg: this.getNutrimentWithConversion(nutriments, "omega-6-fat", 1000),
    };
  }

  private async runSearch(
    query: string,
    limit: number,
    localeOverride?: SearchLocalePreferences,
  ): Promise<FoodDatabaseResult[]> {
    const localePreferences = localeOverride ?? this.localePreferences;
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
      .map((product) => this.parseProduct(product, true))
      .filter((product): product is FoodDatabaseResult => product !== null);
  }
}
