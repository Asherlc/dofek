# @dofek/nutrition

Domain logic for food tracking, nutrient analysis, and daily metrics.

## Implementation Details

### Nutrient Catalog (`nutrients.ts`)
The `NUTRIENTS` constant is the single source of truth for micronutrient metadata. It consolidates:
- **RDA**: NIH Recommended Daily Allowances (e.g., 900mcg for Vitamin A).
- **OFF Mapping**: Maps internal IDs to Open Food Facts keys (e.g., `vitamin-pp` for Niacin).
- **Conversion Factors**: Normalizes OFF data (e.g., multiplier of 1000 for sodium grams to mg).
- **Legacy Support**: `legacyFieldsToNutrients` migrates camelCase provider fields to normalized snake_case identifiers.

### Open Food Facts Integration (`open-food-facts.ts`)
- **Localized Search**: `OpenFoodFactsClient` uses locale detection to prefer regional products (e.g., prioritizing US products for `en-US`).
- **Nutrient Extraction**: `lookupBarcode` and `searchFoods` use `zod` schemas to safely parse the OFF API v2 response, preferring `_serving` fields over `_100g` when available.

### Daily Metrics & Body Measurements (`daily-metrics.ts`, `body-measurements.ts`)
- **Canonical Types**: Defines `DAILY_METRIC_TYPES` (resting HR, steps, VO2max, etc.) and `MEASUREMENT_TYPES` (weight, body fat %, blood pressure).
- **Priority Logic**: Metrics have a `priorityCategory` ("recovery" or "activity") used by the database view to deduplicate data when multiple providers report for the same day.
- **Unit Management**: Standardizes units (kg, bpm, ms, etc.) across the system.

### Meal Logic (`meal.ts`)
- **Auto-detection**: `autoMealType` guesses the meal based on the current hour (Breakfast < 10am, Lunch < 2pm, Snack < 5pm, else Dinner).
- **Form Parsing**: `parseQuickAddForm` provides validation and normalization for manual food entry.
