# @dofek/nutrition

Domain logic for food tracking, nutrient analysis, and daily metrics.

## Selected-Date Nutrition Contract

`selected-date-summary.ts` defines the server-owned nutrition summary and its
source-resolution metadata. Web and mobile render this DTO without recomputing
calories, macros, goal progress, or source selection. An available day includes
the contributing and excluded providers/sources; an overlapping-source conflict
has a null summary plus an actionable message and provenance.

Available days also expose a server-authored `contributionGrain` and
`contributionLabel`. The label combines the canonical provider display name with
the source path when one exists, such as `Cronometer (via Apple Health) daily
total`. Web and mobile show this metadata as an informational resolution panel
and preserve the server's exact resolution message and excluded-source labels.
Provider daily aggregates remain excluded from editable meal cards.

The `food.byDate` v1 procedure retains its installed-client contract of
`{ entries, summary }` with a non-null summary and fails with an actionable
precondition error when sources conflict. New web and mobile clients use
`food.byDateV2`, whose separate response contract includes nullable `summary`,
required `resolution` metadata, and nullable `intakeContext`. When a summary is
available, `intakeContext` contains the observed logged calories, the
configured-or-default daily logged-intake target, an uncapped two-value scale,
a neutral below/at/above-target status and explanation, and the limitation that
the target is not an estimate of energy expenditure or calorie balance. Web and
mobile render these server-computed values without recalculating them. Scale
percentages remain server-provided values; clients constrain only the visual
track geometry to its 0-to-100 percent bounds so an unusual over-target value
does not overflow the layout or lose its numerical context.

The database creates these values as query-time projections over raw entries,
consistent with PostgreSQL views being virtual tables defined by a query:
[PostgreSQL `CREATE VIEW`](https://www.postgresql.org/docs/current/sql-createview.html).

## Nutrition Analytics Source Contract

`nutritionAnalytics.micronutrientAdequacyV2` keeps source quality visible before
adequacy interpretation. For the selected window, it reports dates with any
nutrition data, dates with an available canonical contribution set, resolved or
unresolved overlap dates, unresolved conflicts, and contributing or excluded
source labels. Completeness is the percentage of selected calendar days with an
available canonical contribution set; the All-history range has no invented
calendar denominator and therefore returns a null percentage.

Each nutrient separates itemized food, provider daily totals, and explicitly
taken supplements. Per-source rows report each provider/source's contribution
to the nutrient's average over all recorded days for that nutrient. Contributions
and the total use the same denominator, but independently rounded presentation
values can differ by the displayed precision. These values are query-time
projections over `fitness.v_nutrition_canonical_nutrient` and
`fitness.v_nutrition_daily`; they do not introduce another nutrient storage path.
PostgreSQL documents views as query-defined, non-materialized virtual tables in
[`CREATE VIEW`](https://www.postgresql.org/docs/current/sql-createview.html).

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
- **Canonical Types**: Defines `DAILY_METRIC_TYPES` (heart rate variability, steps, skin temperature, etc.) and `MEASUREMENT_TYPES` (weight, body fat %, blood pressure).
- **Priority Logic**: Metrics have a `priorityCategory` ("recovery" or "activity") used by the database view to deduplicate data when multiple providers report for the same day.
- **Unit Management**: Standardizes units (kg, bpm, ms, etc.) across the system.

### Meal Logic (`meal.ts`)
- **Auto-detection**: `autoMealType` guesses the meal based on the current hour (Breakfast < 10am, Lunch < 2pm, Snack < 5pm, else Dinner).
- **Form Parsing**: `parseQuickAddForm` provides validation and normalization for manual food entry.
