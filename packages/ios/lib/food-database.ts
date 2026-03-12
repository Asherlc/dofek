/**
 * Open Food Facts API client for barcode lookups and food search.
 * Free API, no key needed. Returns nutritional data per 100g.
 */

const BASE_URL = "https://world.openfoodfacts.org";

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

interface OpenFoodFactsProduct {
  code?: string;
  product_name?: string;
  brands?: string;
  serving_size?: string;
  nutriments?: {
    "energy-kcal_serving"?: number;
    "energy-kcal_100g"?: number;
    proteins_serving?: number;
    proteins_100g?: number;
    carbohydrates_serving?: number;
    carbohydrates_100g?: number;
    fat_serving?: number;
    fat_100g?: number;
    fiber_serving?: number;
    fiber_100g?: number;
  };
  image_front_small_url?: string;
}

function parseProduct(product: OpenFoodFactsProduct): FoodDatabaseResult | null {
  const name = product.product_name;
  if (!name) return null;

  const n = product.nutriments;
  // Prefer per-serving values, fall back to per-100g
  const calories = n?.["energy-kcal_serving"] ?? n?.["energy-kcal_100g"] ?? null;
  const proteinG = n?.proteins_serving ?? n?.proteins_100g ?? null;
  const carbsG = n?.carbohydrates_serving ?? n?.carbohydrates_100g ?? null;
  const fatG = n?.fat_serving ?? n?.fat_100g ?? null;
  const fiberG = n?.fiber_serving ?? n?.fiber_100g ?? null;

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

/** Look up a product by barcode */
export async function lookupBarcode(barcode: string): Promise<FoodDatabaseResult | null> {
  try {
    const response = await fetch(
      `${BASE_URL}/api/v2/product/${barcode}.json?fields=code,product_name,brands,serving_size,nutriments,image_front_small_url`,
    );
    if (!response.ok) return null;

    const data = await response.json();
    if (data.status !== 1 || !data.product) return null;

    return parseProduct(data.product);
  } catch {
    return null;
  }
}

/** Search foods by text query */
export async function searchFoods(
  query: string,
  limit = 20,
): Promise<FoodDatabaseResult[]> {
  try {
    const params = new URLSearchParams({
      search_terms: query,
      search_simple: "1",
      action: "process",
      json: "1",
      page_size: String(limit),
      fields: "code,product_name,brands,serving_size,nutriments,image_front_small_url",
    });

    const response = await fetch(`${BASE_URL}/cgi/search.pl?${params}`);
    if (!response.ok) return [];

    const data = await response.json();
    const products: OpenFoodFactsProduct[] = data.products ?? [];

    return products
      .map(parseProduct)
      .filter((r): r is FoodDatabaseResult => r !== null);
  } catch {
    return [];
  }
}
